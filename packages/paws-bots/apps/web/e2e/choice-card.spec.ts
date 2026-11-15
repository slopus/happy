import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("onboarding choices show borderless rows in both themes", async ({ page }, testInfo) => {
  await signup(page, `onboarding-rows-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  const question = page.getByText("What do you want me on first?", { exact: true });
  await expect(question).toBeVisible();
  const card = question.locator("xpath=ancestor::div[contains(@class,'bg-card')][1]");
  const option = card.getByRole("button", { name: /Inbox & email/ });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await expect(option).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
    await expect(option).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    await captureScreenshot(page, testInfo, `onboarding-choice-rows-${theme}`);
  }
  await option.focus();
  await expect(option).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(option).toBeDisabled();
  await expect(option).toHaveAttribute("aria-pressed", "true");
  await captureScreenshot(page, testInfo, "onboarding-choice-rows-answered");
});

test("renders tappable choice buttons and submits the offered action id", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `choice-card-${stamp}@rakazo.test`, "password12", "Choice Card");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("pick from these cities with tappable choices");
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
  const prompt = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await prompt.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  await expect(prompt).toBeVisible({ timeout: 15_000 });

  const berlin = page.getByRole("button", { name: "Berlin", exact: true });
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  const toronto = page.getByRole("button", { name: "Toronto", exact: true });
  const lisbon = page.getByRole("button", { name: "Lisbon", exact: true });
  await expect(berlin).toBeVisible();
  await expect(seoul).toBeVisible();
  await expect(toronto).toBeVisible();
  await expect(lisbon).toBeVisible();

  const berlinBox = await berlin.boundingBox();
  const seoulBox = await seoul.boundingBox();
  const torontoBox = await toronto.boundingBox();
  expect(berlinBox).toBeTruthy();
  expect(seoulBox).toBeTruthy();
  expect(torontoBox).toBeTruthy();
  expect(seoulBox!.y).toBeGreaterThan(berlinBox!.y + berlinBox!.height - 2);
  expect(torontoBox!.y).toBeGreaterThan(seoulBox!.y + seoulBox!.height - 2);
  expect(Math.abs(berlinBox!.x - seoulBox!.x)).toBeLessThan(2);
  expect(Math.abs(berlinBox!.width - seoulBox!.width)).toBeLessThan(2);
  // Rows bleed past the list so the hover fill frames the letter and label.
  const listBox = await berlin.locator("xpath=..").boundingBox();
  expect(listBox).toBeTruthy();
  expect(berlinBox!.width).toBeGreaterThanOrEqual(listBox!.width);
  await captureScreenshot(page, testInfo, "choice-card");

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(berlin).toBeVisible();
  await expect(lisbon).toBeVisible();
  const narrowBerlin = await berlin.boundingBox();
  const narrowLisbon = await lisbon.boundingBox();
  expect(narrowBerlin).toBeTruthy();
  expect(narrowLisbon).toBeTruthy();
  expect(narrowLisbon!.y).toBeGreaterThan(narrowBerlin!.y);
  await expect(lisbon).toBeEnabled();
  await captureScreenshot(page, testInfo, "choice-card-narrow");

  await page.setViewportSize({ width: 1280, height: 720 });
  await seoul.click();

  await expect(seoul).toHaveAttribute("aria-pressed", "true", { timeout: 30_000 });
  await expect(seoul).toBeDisabled();

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{
            blocks: Array<{
              kind: string;
              status?: string;
              answer?: string;
              actions?: Array<{ id: string; label: string }>;
            }>;
          }>;
        }>(page, "threads/messages", { botId });
        const answered = history.messages
          .flatMap((message) => message.blocks)
          .find(
            (block) =>
              block.kind === "ask" &&
              block.status === "answered" &&
              Array.isArray(block.actions) &&
              block.actions.some((action) => action.id === "choice-2"),
          );
        return answered?.answer ?? null;
      },
      { timeout: 30_000 },
    )
    .toBe("choice-2");

  await captureScreenshot(page, testInfo, "choice-card-answered");

  // A custom composer reply closes the options without repeating its answer in the card.
  await composer.fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");
  const customQuestion = page.getByTestId("question-card").last();
  await expect(customQuestion.getByRole("button", { name: "Seoul", exact: true })).toBeEnabled({
    timeout: 30_000,
  });
  await composer.fill("Somewhere else");
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("message-user-bubble").filter({ hasText: /^Somewhere else$/ }),
  ).toBeVisible();
  await expect(customQuestion).toHaveClass(/opacity-50/);
  await expect(customQuestion).not.toContainText("Somewhere else");
  for (const name of ["Berlin", "Seoul", "Toronto", "Lisbon"]) {
    await expect(customQuestion.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await customQuestion.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "choice-card-composer-reply-dark");
});

test("shows the content being decided on above the choices", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ask-detail-${stamp}@rakazo.test`, "password12", "Ask Detail");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  await page.getByPlaceholder(/Message/).fill("send the draft on the card");
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

  const question = page.locator("p").filter({ hasText: /^Send this email to Ana\?$/ });
  if ((await question.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByPlaceholder(/Message/)).toBeVisible({ timeout: 15_000 });
  }
  const detail = page.getByTestId("ask-detail");
  await expect(question).toBeVisible({ timeout: 15_000 });
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("To: ana@example.test");
  await expect(detail).toContainText("The draft body.");
  await expect(page.getByRole("button", { name: "Send it", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ask-detail");
});
