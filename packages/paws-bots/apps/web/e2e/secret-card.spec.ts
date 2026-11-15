import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { BLOCKED_ITEM_ANSWER } from "@rakazo/contracts";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("renders masked secret card and saves without putting the value in chat", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `secret-card-${stamp}@rakazo.test`, "password12", "Secret Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("show a secret card for a masked api key");
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
  await expect(card.getByText("API key", { exact: true }).first()).toBeVisible();
  await expect(card.getByText("https://api.example.test", { exact: true })).toBeVisible();
  const secretField = card.getByLabel("API key");
  await expect(secretField).toHaveAttribute("type", "password");
  await expect(card.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  await expect(secretField).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  const secretValue = `sk-test-secret-${stamp}`;
  // Clear sensitive client state before waiting for a network result, including failures.
  let releaseFailure!: () => void;
  const failureGate = new Promise<void>((resolve) => {
    releaseFailure = resolve;
  });
  await page.route("**/rpc/threads/answer", async (route) => {
    await failureGate;
    await route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: secretValue } },
    });
  });
  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(secretField).toHaveValue("");
    await expect(secretField).toBeDisabled();
    await expect(card.getByRole("button", { name: "Saving…", exact: true })).toBeDisabled();
  } finally {
    releaseFailure();
  }
  await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(secretField).toHaveValue("");
  await page.unroute("**/rpc/threads/answer");

  // The owner blocked bots from this item while the card waited: the card says why, translated.
  await page.route("**/rpc/threads/answer", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: { defined: false, code: "BAD_REQUEST", status: 400, message: BLOCKED_ITEM_ANSWER },
      },
    }),
  );
  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect(card.getByText(BLOCKED_ITEM_ANSWER, { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "secret-card-blocked");
  await page.unroute("**/rpc/threads/answer");

  await secretField.fill(secretValue);
  await card.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("Saved", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await expect(composer).not.toHaveValue(secretValue);

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            blocks: Array<{
              kind: string;
              status?: string;
              answer?: string;
              input?: string;
              text?: string;
              detail?: string;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" && block.input === "secret" && block.status === "answered",
          );
        if (!answered) return null;
        const serialized = JSON.stringify(history);
        if (serialized.includes(secretValue)) return "leaked";
        return answered.answer ?? "";
      },
      { timeout: 30_000 },
    )
    .toBe("");

  // Check again after the worker resumes, then reload to verify the durable Saved state.
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
  const history = await rpc(page, "threads/messages", { botId });
  expect(JSON.stringify(history)).not.toContain(secretValue);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Saved", { exact: true })).toBeVisible();
  await expect(card.locator("input")).toHaveCount(0);
  await expect(page.getByText(secretValue)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "secret-card-saved");
});

async function openSecretCard(page: Page, name: string, prompt: string) {
  const stamp = Date.now();
  await signup(page, `secret-${name}-${stamp}@rakazo.test`, "password12", "Secret Lines");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill(prompt);
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
  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  // Every save is rejected, so one card takes many answers; each is recorded as sent.
  const answers: string[] = [];
  const loginAnswers: Array<{ label: string; value: string; hidden: boolean }[]> = [];
  const dismissals: boolean[] = [];
  await page.route("**/rpc/threads/answer", async (route) => {
    const { answer, fields, dismiss } = route.request().postDataJSON().json;
    answers.push(answer);
    if (fields) loginAnswers.push(fields);
    dismissals.push(dismiss === true);
    await route.fulfill({
      status: 400,
      json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: "rejected" } },
    });
  });
  return { card, answers, loginAnswers, dismissals, stamp };
}

test(
  "saves a multi-line command variable exactly as pasted",
  { tag: "@nightly" },
  async ({ page, context }, testInfo) => {
    const { card, answers, dismissals, stamp } = await openSecretCard(
      page,
      "command",
      "show a command variable secret card",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const field = card.getByLabel("API key");
    const save = card.getByRole("button", { name: "Save", exact: true });
    const clear = card.getByRole("button", { name: "Clear", exact: true });
    const key = `-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA${stamp}\nQyNTUxOQAAACBmYWtl\n-----END OPENSSH PRIVATE KEY-----\n`;
    const copy = (value: string) =>
      page.evaluate((text) => navigator.clipboard.writeText(text), value);
    let sent = 0;
    const saved = async (expected: string, submit = () => save.click()) => {
      await submit();
      sent += 1;
      await expect.poll(() => answers.length).toBe(sent);
      expect(answers[sent - 1]).toBe(expected);
      await expect(field).toHaveValue("");
      await expect(field).not.toHaveAttribute("readonly");
    };
    const paste = async () => {
      await page.keyboard.press("ControlOrMeta+v");
      await expect(field).toHaveAttribute("readonly");
    };

    // A single line copied with a trailing line break saves without it, as before.
    await copy("sk-single-line\n");
    await field.click();
    await page.keyboard.press("ControlOrMeta+v");
    await expect(field).not.toHaveAttribute("readonly");
    await saved("sk-single-line");

    await copy(key);
    // Into an empty field, then undo and redo, which can't change a read-only field.
    await field.click();
    await paste();
    await expect(field).toHaveAttribute("type", "password");
    await expect(clear).toBeVisible();
    await captureScreenshot(page, testInfo, "secret-card-multiline");
    await page.keyboard.press("ControlOrMeta+z");
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await saved(key);

    // Into the middle of typed text.
    await field.fill("ab");
    await page.keyboard.press("ArrowLeft");
    await paste();
    await saved(`a${key}b`);

    // Over all of the typed text.
    await field.fill("typed");
    await page.keyboard.press("ControlOrMeta+a");
    await paste();
    await saved(key);

    // Deleting across a line break, pasting again, and undo all leave the pasted value.
    await field.click();
    await paste();
    await page.keyboard.press("End");
    for (const press of ["Backspace", "ArrowLeft", "Delete", "ControlOrMeta+z", "ControlOrMeta+v"])
      await page.keyboard.press(press);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type("x");
    await saved(key);

    // Tab and Escape don't change it, and Enter saves it.
    await field.click();
    await paste();
    await page.keyboard.press("Tab");
    await field.focus();
    await page.keyboard.press("Escape");
    await saved(key, () => field.press("Enter"));

    // Showing the value doesn't change what is saved.
    await field.click();
    await paste();
    await card.getByRole("button", { name: "Show password" }).click();
    await expect(field).toHaveAttribute("type", "text");
    await card.getByRole("button", { name: "Hide password" }).click();
    await saved(key);

    // Dropped text is kept the same way.
    await page.evaluate((value) => {
      const source = document.createElement("div");
      source.id = "drag-key";
      source.draggable = true;
      source.textContent = "key";
      source.addEventListener("dragstart", (event) =>
        event.dataTransfer?.setData("text/plain", value),
      );
      document.body.append(source);
    }, key);
    await page.dragAndDrop(
      "#drag-key",
      '[data-testid="secret-ask-card"] input[aria-label="API key"]',
    );
    await expect(field).toHaveAttribute("readonly");
    await saved(key);

    // Clear empties the field and makes it editable again.
    await field.click();
    await paste();
    await clear.click();
    await expect(field).toHaveValue("");
    await expect(field).toBeFocused();
    await expect(clear).toHaveCount(0);
    await page.keyboard.type("token");
    await saved("token");

    // Windows and old Mac line endings are saved as \n.
    await copy(key.replaceAll("\n", "\r\n"));
    await field.click();
    await paste();
    await saved(key);
    await copy(key.replaceAll("\n", "\r"));
    await field.click();
    await paste();
    await saved(key);

    // A rejected dismissal sends no value and leaves the field empty and editable.
    await copy(key);
    await field.click();
    await paste();
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    sent += 1;
    await expect.poll(() => answers.length).toBe(sent);
    expect([answers[sent - 1], dismissals[sent - 1]]).toEqual(["", true]);
    await expect(card.getByText("Could not submit this answer", { exact: true })).toBeVisible();
    await expect(field).toHaveValue("");
    await expect(field).not.toHaveAttribute("readonly");
    await expect(clear).toHaveCount(0);
    await field.click();
    await paste();
    await saved(key);

    // A dismissal that goes through removes the field.
    await page.unroute("**/rpc/threads/answer");
    await field.click();
    await paste();
    await card.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(card.getByText("Dismissed", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(card.locator("input")).toHaveCount(0);
  },
);

test("keeps other secret cards on one line", { tag: "@nightly" }, async ({ page, context }) => {
  const { card, answers } = await openSecretCard(
    page,
    "bearer",
    "show a secret card for a masked api key",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("sk-one\nsk-two"));
  await card.getByLabel("API key").click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(card.getByLabel("API key")).not.toHaveAttribute("readonly");
  await expect(card.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);
  await card.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => answers).toEqual(["sk-one sk-two"]);
});

test("keeps a website login password on one line", { tag: "@nightly" }, async ({
  page,
  context,
}) => {
  const { card, loginAnswers } = await openSecretCard(page, "login", "show a login card");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByTestId("vault-editor");
  await form.getByLabel("Username", { exact: true }).fill("someone");
  await page.evaluate(() => navigator.clipboard.writeText("pass-one\npass-two"));
  await form.getByLabel("Password", { exact: true }).click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(form.getByLabel("Password", { exact: true })).not.toHaveAttribute("readonly");
  await form.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(() => loginAnswers)
    .toEqual([
      [
        { label: "Username", value: "someone", hidden: false },
        { label: "Password", value: "pass-one pass-two", hidden: true },
      ],
    ]);
});

test("uses a login for this run only when Save to Vault is turned off on its card", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `login-once-${stamp}@rakazo.test`, "password12", "Login Once");
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

  const card = page.getByTestId("secret-ask-card");
  if ((await card.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.getByRole("button", { name: "Add", exact: true }).click();
  const form = page.getByTestId("vault-editor");
  const saveToVault = form.getByRole("switch", { name: "Save to Vault" });
  await expect(saveToVault).toBeChecked();
  await expect(form.getByRole("button", { name: "Save", exact: true })).toBeVisible();

  const username = form.getByLabel("Username", { exact: true });
  const password = `fake-login-password-${stamp}`;
  await username.fill(`fake-user-${stamp}@example.test`);
  await form.getByLabel("Password", { exact: true }).fill(password);
  await saveToVault.click();
  await expect(saveToVault).not.toBeChecked();
  // Turning it off keeps what was typed.
  await expect(username).toHaveValue(`fake-user-${stamp}@example.test`);
  const send = form.getByRole("button", { name: "Continue", exact: true });
  await expect(send).toBeEnabled();
  await captureScreenshot(page, testInfo, "login-card-save-off");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(saveToVault).toBeVisible();
  await captureScreenshot(page, testInfo, "login-card-save-off-narrow");
  await page.setViewportSize({ width: 1280, height: 720 });

  await send.click();
  await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 30_000 });
  // Nothing went into the vault, and the answered card still reads Sent after a reload.
  expect(await rpc<unknown[]>(page, "vault/list", { scope: "account" })).toHaveLength(0);
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(card.getByText("Sent", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(password)).toHaveCount(0);
  await captureScreenshot(page, testInfo, "login-card-sent");
});
