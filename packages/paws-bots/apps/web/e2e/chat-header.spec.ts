import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("the chat header floats over the transcript", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await signup(page, `chat-header-${Date.now()}@rakazo.test`, "password12", "Sample");
  await completeOnboarding(page);
  await rpc(page, "onboarding/dismissFocus", { botId: activeBotId(page) });

  const composer = page.getByRole("combobox", { name: /Message/ });
  const transcript = page.getByTestId("transcript");
  for (let item = 1; item <= 8; item++) {
    const text = `Question ${item}: what is the status of launch item ${item}? The draft is reviewed and the checklist is complete.`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(transcript.getByText(text, { exact: true })).toBeVisible();
  }

  const header = await page.getByTestId("bot-settings-trigger").boundingBox();
  const scroller = await transcript.boundingBox();
  if (!header || !scroller) throw new Error("missing chat layout");
  // Messages scroll under the floating header rather than stopping below a bar.
  expect(scroller.y).toBeLessThan(header.y);
  const gapHitsTranscript = await page.evaluate(
    ({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('[data-testid="transcript"]')),
    { x: scroller.x + scroller.width / 4, y: header.y + header.height / 2 },
  );
  expect(gapHitsTranscript).toBe(true);

  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute("data-theme", value),
      theme,
    );
    await captureScreenshot(page, testInfo, `chat-header-floating-${theme}`);
  }

  await transcript.evaluate((element) => {
    element.scrollTop = 0;
  });
  const first = await transcript
    .getByText(/^Question 1:/)
    .first()
    .boundingBox();
  if (!first) throw new Error("missing first message");
  expect(first.y).toBeGreaterThan(header.y + header.height);
});
