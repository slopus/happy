import type { Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

/**
 * Build a real browser Selection over `startNeedle` … `endNeedle` inside `scope`
 * (a row for same-message picks, the transcript for cross-message picks), then
 * fire a trusted mouseup over the transcript so the app re-reads the selection.
 * A lone mouse.up keeps the selection alive — a mousedown would clear it first.
 * Pass `release: false` to exercise the selectionchange-only path instead.
 */
async function selectAndRelease(
  page: Page,
  scope: Locator,
  startNeedle: string,
  endNeedle = startNeedle,
  options: { release?: boolean } = {},
) {
  await scope.evaluate(
    (el, { startNeedle, endNeedle }) => {
      // The quote pill positions itself off the selection rect — keep the scope
      // inside the viewport or a fixed-position pill renders offscreen.
      el.scrollIntoView({ block: "center" });
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: Text[] = [];
      let node = walker.nextNode();
      while (node) {
        nodes.push(node as Text);
        node = walker.nextNode();
      }
      const find = (needle: string, fromEnd: boolean) => {
        const list = fromEnd ? [...nodes].reverse() : nodes;
        for (const text of list) {
          const idx = text.textContent?.indexOf(needle) ?? -1;
          if (idx >= 0) return { node: text, idx };
        }
        return null;
      };
      const start = find(startNeedle, false);
      const end = find(endNeedle, true);
      if (!start || !end) throw new Error(`selection needles not found: ${startNeedle}`);
      const range = document.createRange();
      range.setStart(start.node, start.idx);
      range.setEnd(end.node, end.idx + endNeedle.length);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    },
    { startNeedle, endNeedle },
  );
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  if (!selected.includes(startNeedle)) {
    throw new Error(`selection did not stick (got: "${selected.slice(0, 80)}")`);
  }
  if (options.release === false) return;
  const transcript = page.getByTestId("transcript");
  const box = await transcript.boundingBox();
  if (!box) throw new Error("transcript not laid out");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.up();
}

test("selecting a text span quotes it into a reply", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `quote-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const quoteButton = page.getByTestId("quote-selection");

  const sourceText = `quote-source-${stamp} shows **forty two percent** growth`;
  await composer.fill(sourceText);
  await composer.press("Enter");
  const sourceRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: `quote-source-${stamp}` })
    .first();
  await expect(sourceRow).toBeVisible({ timeout: 20_000 });

  await selectAndRelease(page, sourceRow, "**forty two percent**");
  await expect(quoteButton).toBeVisible();
  await captureScreenshot(page, testInfo, "message-quote-selection");
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // A selection with no mouse release (keyboard, assistive tech) still offers
  // Quote — the affordance hangs off selectionchange, not mouseup.
  await selectAndRelease(page, sourceRow, "**forty two percent**", "**forty two percent**", {
    release: false,
  });
  await expect(quoteButton).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(quoteButton).toHaveCount(0);

  // Quoting arms the existing reply flow with the excerpt in the chip. The
  // pill unmounts on click, so focus must land in the composer — and the
  // chip's arrival is announced through the composer live region.
  await selectAndRelease(page, sourceRow, "**forty two percent**");
  await expect(quoteButton).toBeVisible();
  await quoteButton.click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-announcement")).toHaveText(/Replying to/);
  await expect(replyChip).toContainText(/forty two percent/);
  await expect(replyChip).toContainText("**forty two percent**");

  const replyText = `quote-reply-${stamp} why this number?`;
  await composer.fill(replyText);
  await composer.press("Enter");
  await expect(replyChip).toHaveCount(0);
  // Sending disarms the reply — the live region must not keep a stale
  // "Replying to" that no longer describes anything after the chip is gone.
  await expect(page.getByTestId("composer-announcement")).toHaveText("");

  const replyRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: replyText })
    .first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  // The accessible name names the action AND the excerpt — the quote must not
  // be masked by a bare "Jump to replied message" label.
  await expect(parentPreview).toHaveAccessibleName(/Jump to replied message:.*forty two percent/);
  await expect(parentPreview).toContainText("**forty two percent**");
  await expect(parentPreview).not.toContainText("quote-source");
  await captureScreenshot(page, testInfo, "message-quote-reply");

  await parentPreview.click();
  await expect(sourceRow).toBeInViewport();

  await page.reload();
  const reloadedRow = transcript
    .locator("[data-message-id]")
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: replyText })
    .first();
  await expect(reloadedRow).toBeVisible({ timeout: 20_000 });
  await expect(reloadedRow.getByTestId("reply-parent-preview")).toContainText(
    "**forty two percent**",
  );
});

test("an armed reply survives the parent paging out of the transcript", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-evict-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const botId = activeBotId(page);
  const userRow = (text: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: text })
      .first();

  const parentText = `quote-evict-parent-${stamp}`;
  await composer.fill(parentText);
  await composer.press("Enter");
  const parentRow = userRow(parentText);
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  await selectAndRelease(page, parentRow, `evict-parent-${stamp}`);
  await page.getByTestId("quote-selection").click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(`evict-parent-${stamp}`);

  // Newer durable messages push the parent out of the latest page (window is
  // 100). While the flood's runs are alive, refreshes race the event stream and
  // get discarded as stale — so stop the thread to end the churn first.
  for (let i = 0; i < 105; i++) {
    await rpc(page, "threads/send", {
      botId,
      text: `quote-filler-${stamp}-${i}`,
      clientNonce: `qf-${stamp}-${i}`,
    });
  }
  const lastFiller = userRow(`quote-filler-${stamp}-104`);
  await expect(lastFiller).toBeVisible({ timeout: 30_000 });
  const lastFillerId = await lastFiller.getAttribute("data-message-id");
  expect(lastFillerId).toBeTruthy();
  await rpc(page, "threads/stop", { botId });
  // stop deletes the cancelled runs' thread.progress events; if one of those
  // was the last applied event, the live cursor outranks every later snapshot
  // and refreshes are discarded as stale. A reaction writes one durable event
  // past the wedge — no run, no new churn — so the next refresh can commit.
  await rpc(page, "threads/react", {
    botId,
    messageId: lastFillerId,
    reaction: "👍",
    clientNonce: `qr-${stamp}`,
  });
  // Opening the bot panel refreshes the thread.
  const panelButton = page.getByTestId("bot-settings-trigger");
  await expect(async () => {
    if ((await panelButton.getAttribute("aria-expanded")) === "true") {
      await panelButton.click();
    }
    await panelButton.click();
    await expect(parentRow).toHaveCount(0, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await expect(replyChip).toBeVisible();

  const replyText = `quote-evict-reply-${stamp}`;
  await composer.fill(replyText);
  await composer.press("Enter");
  const replyRow = userRow(replyText);
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(`evict-parent-${stamp}`);

  // The link still reaches the evicted parent via the around-page jump.
  await parentPreview.click();
  await expect(userRow(parentText)).toBeVisible({ timeout: 20_000 });

  // Stop the reply's run so its continues cannot churn into the next test.
  await rpc(page, "threads/stop", { botId });
});

test("triple-clicking the last paragraph of the latest reply quotes it", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-triple-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill(`quote-triple-${stamp}`);
  await composer.press("Enter");
  // The scripted bot answers in two paragraphs; the last one ends the transcript,
  // so a triple-click's selection runs on into the composer.
  const lastParagraph = page
    .getByTestId("message-bot-bubble")
    .locator("p")
    .filter({ hasText: `i handled: quote-triple-${stamp}` });
  await expect(lastParagraph).toBeVisible({ timeout: 20_000 });

  await lastParagraph.click({ clickCount: 3 });
  const quoteButton = page.getByTestId("quote-selection");
  await expect(quoteButton).toBeVisible();
  await quoteButton.click();
  await expect(page.getByTestId("reply-chip")).toContainText(`i handled: quote-triple-${stamp}`);
});

test("quoting a second message retargets the armed reply", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `quote-switch-${stamp}@rakazo.test`, "password12", "Quote Tester");
  await completeOnboarding(page);

  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const quoteButton = page.getByTestId("quote-selection");
  const replyChip = page.getByTestId("reply-chip");
  const userRow = (text: string) =>
    transcript
      .locator("[data-message-id]")
      .filter({ has: page.getByTestId("message-user-bubble") })
      .filter({ hasText: text })
      .first();

  const firstText = `quote-switch-a-${stamp}`;
  const secondText = `quote-switch-b-${stamp}`;
  // Each send must resolve before the next Enter — the composer swallows
  // input while a send is in flight.
  const sentFirst = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.fill(firstText);
  await composer.press("Enter");
  await sentFirst;
  const firstRow = userRow(firstText);
  await expect(firstRow).toBeVisible({ timeout: 20_000 });
  const sentSecond = page.waitForResponse(
    (response) => response.url().includes("/rpc/threads/send") && response.ok(),
  );
  await composer.fill(secondText);
  await composer.press("Enter");
  await sentSecond;
  const secondRow = userRow(secondText);
  await expect(secondRow).toBeVisible({ timeout: 20_000 });

  // Arm a quote on the first message…
  await selectAndRelease(page, firstRow, firstText);
  await quoteButton.click();
  await expect(replyChip).toContainText("switch-a");
  await expect(composer).toBeFocused();

  // …then quote the second: the chip retargets, the announcement re-fires,
  // and focus returns to the composer instead of dropping to <body>.
  await secondRow.scrollIntoViewIfNeeded();
  await selectAndRelease(page, secondRow, secondText);
  await quoteButton.click();
  await expect(replyChip).toContainText("switch-b");
  await expect(replyChip).not.toContainText("switch-a");
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-announcement")).toHaveText(/Replying to/);

  // Cancelling announces the cancel in the same event that disarms the reply —
  // the send-disarm clear must not wipe it.
  await page.getByRole("button", { name: "Cancel reply" }).click();
  await expect(replyChip).toHaveCount(0);
  await expect(composer).toBeFocused();
  await expect(page.getByTestId("composer-announcement")).toHaveText(/Reply cancelled/);
});
