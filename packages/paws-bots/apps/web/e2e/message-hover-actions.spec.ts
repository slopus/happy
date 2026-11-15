import type { Locator, Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

/** Submit from the Send control so an in-flight prior send cannot swallow Enter. */
async function sendComposerMessage(page: Page, composer: Locator, text: string) {
  await composer.fill(text);
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(composer).toHaveValue("");
}

async function revealHoverRail(row: Locator): Promise<Locator> {
  const rail = row.getByTestId("message-hover-rail");
  await expect
    .poll(async () => {
      await row.hover();
      return rail.evaluate((element) => {
        const style = getComputedStyle(element);
        return { opacity: style.opacity, pointerEvents: style.pointerEvents };
      });
    })
    .toEqual({ opacity: "1", pointerEvents: "auto" });
  // Incoming replies can move the row away from the pointer; keep real focus for screenshots.
  await rail.getByRole("button", { name: "More" }).focus();
  return rail;
}

/** Touch drops the side gutter, so the bubble cap stays wider than the row minus 8rem. */
async function expectNoTouchSideGutter(frame: Locator) {
  const widths = await frame.evaluate((element) => {
    const parentWidth = element.parentElement?.getBoundingClientRect().width ?? 0;
    const maxWidth = getComputedStyle(element).maxWidth;
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    // Let the browser resolve the cap (it mixes percentages and rem) by
    // overflowing the frame and reading back its clamped width.
    const frame = element as HTMLElement;
    const width = frame.style.width;
    frame.style.width = "100000px";
    const max = frame.getBoundingClientRect().width;
    frame.style.width = width;
    return {
      parentWidth,
      max,
      maxWidth,
      gutter: 8 * rem,
    };
  });
  expect(widths.parentWidth).toBeGreaterThan(widths.gutter);
  expect(widths.max, `max-width ${widths.maxWidth}`).toBeGreaterThan(
    widths.parentWidth - widths.gutter,
  );
}

/** Park the pointer outside the message and blur focus so the rail returns to opacity-0. */
async function expectRailAtRest(page: Page, row: Locator) {
  const rail = row.getByTestId("message-hover-rail");
  const box = await row.boundingBox();
  if (box) {
    // (0,0) can still sit on the first transcript row; leave below the row instead.
    await page.mouse.move(Math.max(0, box.x) + 8, box.y + box.height + 32);
  }
  // More keeps focus after Escape; blur so focus-within does not leave the rail visible.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await expect(rail).toHaveCSS("opacity", "0");
  await expect(rail).toHaveCSS("pointer-events", "none");
}

async function expectHeaderAboveHoveredRow(page: Page, testInfo: TestInfo, row: Locator) {
  const placement = await row.evaluate((element) => {
    const transcript = element.closest<HTMLElement>('[data-testid="transcript"]');
    const header = document.querySelector<HTMLElement>('[data-testid="bot-settings-trigger"]');
    if (!transcript || !header) throw new Error("missing transcript or chat header");

    // Make even a short thread scrollable so the row can sit underneath the header.
    const originalScrollTop = transcript.scrollTop;
    const spacer = document.createElement("div");
    spacer.dataset.layerTestSpacer = "";
    spacer.style.height = `${transcript.clientHeight}px`;
    spacer.style.flexShrink = "0";
    transcript.append(spacer);

    const transcriptBox = transcript.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const headerPoint = {
      x: headerBox.left + headerBox.width / 2,
      y: headerBox.top + headerBox.height / 2,
    };
    const rowBox = element.getBoundingClientRect();
    const rowCenterContentY =
      rowBox.top - transcriptBox.top + transcript.scrollTop + rowBox.height / 2;
    transcript.scrollTop = rowCenterContentY - (headerPoint.y - transcriptBox.top);
    const movedRowBox = element.getBoundingClientRect();

    return {
      originalScrollTop,
      headerPoint,
      hoverPoint: { x: movedRowBox.left + 1, y: headerPoint.y },
      overlapsHeader:
        movedRowBox.left < headerPoint.x &&
        movedRowBox.right > headerPoint.x &&
        movedRowBox.top < headerPoint.y &&
        movedRowBox.bottom > headerPoint.y,
    };
  });

  try {
    expect(placement.overlapsHeader).toBe(true);
    // Rows keep their rails and avatars layered among themselves, never over the header.
    await expect(page.getByTestId("transcript")).toHaveCSS("isolation", "isolate");
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The header's empty gutter passes pointer events through to keep the row hovered.
    await page.mouse.move(placement.hoverPoint.x, placement.hoverPoint.y);
    await expect(row.getByTestId("message-hover-rail")).toHaveCSS("opacity", "1");
    const headerReceivesHit = await page.evaluate(({ x, y }) => {
      const header = document.querySelector<HTMLElement>('[data-testid="bot-settings-trigger"]');
      const topmost = document.elementFromPoint(x, y);
      return Boolean(header && topmost && header.contains(topmost));
    }, placement.headerPoint);
    expect(headerReceivesHit).toBe(true);
    await captureScreenshot(page, testInfo, "message-hover-under-header-desktop");
  } finally {
    await row.evaluate((element, originalScrollTop) => {
      const transcript = element.closest<HTMLElement>('[data-testid="transcript"]');
      transcript?.querySelector("[data-layer-test-spacer]")?.remove();
      if (transcript) transcript.scrollTop = originalScrollTop;
    }, placement.originalScrollTop);
  }
}

test("message hover shows beside-bubble actions; reply links to parent", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-actions-${stamp}@rakazo.test`, "password12", "Hover Actions");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);

  const transcript = page.getByTestId("transcript");

  // Empty start: no Fresh-start greeting. Answer the focus card so a plain
  // bot text bubble exists for hover layout checks.
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const botRow = transcript.locator(`[data-message-id]`).filter({ has: botText }).first();
  await expect(botRow).toBeVisible();
  await expectRailAtRest(page, botRow);
  await captureScreenshot(page, testInfo, "message-actions-rest-desktop");

  const botRail = await revealHoverRail(botRow);
  const botToolbar = botRow.getByTestId("message-hover-actions");
  await expect(botRow.locator("time")).toHaveCount(0);

  await expect(botToolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(botToolbar.getByRole("button", { name: "More" })).toBeVisible();
  // Measure a unique visible bubble, so an oversized wrapper cannot hide a gap.
  const botBubble = botRow.getByTestId("message-bot-bubble").first();
  await expect
    .poll(async () => {
      const railBox = await botRail.boundingBox();
      const bubbleBox = await botBubble.boundingBox();
      if (!railBox || !bubbleBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const bubbleMid = bubbleBox.y + bubbleBox.height / 2;
      return {
        beside: railBox.x >= bubbleBox.x + bubbleBox.width - 2,
        flush: railBox.x - (bubbleBox.x + bubbleBox.width) < 8,
        centered: Math.abs(railMid - bubbleMid) <= 12,
        notBelow: railBox.y + railBox.height <= bubbleBox.y + bubbleBox.height + 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });
  await captureScreenshot(page, testInfo, "message-bot-actions-desktop");
  await expectRailAtRest(page, botRow);

  const parentText = `hover-parent-${stamp}`;
  const replyText = `hover-reply-${stamp}`;
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await sendComposerMessage(page, composer, parentText);

  const parentRow = transcript.locator(`[data-message-id]`).filter({ hasText: parentText }).first();
  await expect(parentRow).toBeVisible({ timeout: 20_000 });

  const rail = await revealHoverRail(parentRow);
  const toolbar = parentRow.getByTestId("message-hover-actions");
  await expect(toolbar.getByRole("button", { name: "Reply" })).toBeVisible();
  await expect(toolbar.getByRole("button", { name: "More" })).toBeVisible();
  const react = toolbar.getByRole("button", { name: "React" });
  await expect(react).toBeVisible();
  await expect
    .poll(async () => {
      const mutedColor = await toolbar
        .getByRole("button", { name: "More" })
        .evaluate((el) => getComputedStyle(el).color);
      const reactionColor = await react.evaluate((el) => getComputedStyle(el).color);
      return reactionColor === mutedColor;
    })
    .toBe(true);

  const frame = parentRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const frameBox = await frame.boundingBox();
      if (!railBox || !frameBox) return null;
      const railMid = railBox.y + railBox.height / 2;
      const frameMid = frameBox.y + frameBox.height / 2;
      return {
        beside: railBox.x + railBox.width <= frameBox.x + 2,
        flush: frameBox.x - (railBox.x + railBox.width) < 8,
        centered: Math.abs(railMid - frameMid) <= 12,
        notBelow: railBox.y >= frameBox.y - 12,
      };
    })
    .toEqual({ beside: true, flush: true, centered: true, notBelow: true });

  const userSurface = parentRow.getByTestId("message-user-bubble");
  await expect(userSurface).toBeVisible();
  await expect
    .poll(async () => userSurface.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toMatch(/^rgb\(241,\s*241,\s*239\)$/); // not cream primary foreground

  const longText = `hover-long-${stamp}-${"x".repeat(220)}`;
  await sendComposerMessage(page, composer, longText);
  const longRow = transcript
    .locator(`[data-message-id]`)
    .filter({ hasText: longText.slice(0, 40) })
    .first();
  await expect(longRow).toBeVisible({ timeout: 20_000 });
  const longRail = await revealHoverRail(longRow);
  const longFrame = longRow.getByTestId("message-bubble-frame");
  await expect
    .poll(async () => {
      const railBox = await longRail.boundingBox();
      const frameBox = await longFrame.boundingBox();
      if (!railBox || !frameBox) return null;
      return Math.abs(frameBox.x - (railBox.x + railBox.width));
    })
    .toBeLessThan(8);
  await captureScreenshot(page, testInfo, "message-bubble-wide-desktop");

  await revealHoverRail(parentRow);
  await toolbar.getByRole("button", { name: "More" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await expect(page.getByRole("menu").locator("time")).toHaveCount(0);
  // Escape closes More and restores focus to the trigger so the rail stays up.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(toolbar.getByRole("button", { name: "More" })).toBeFocused();
  await captureScreenshot(page, testInfo, "message-user-actions-hover-desktop");
  await expectRailAtRest(page, parentRow);
  await captureScreenshot(page, testInfo, "message-user-bubble-desktop");

  await revealHoverRail(parentRow);
  const railBox = await rail.boundingBox();
  const frameBox = await frame.boundingBox();
  if (!railBox || !frameBox) throw new Error("missing hover toolbar geometry");
  const pad = 16;
  const top = Math.min(railBox.y, frameBox.y);
  const clip = {
    x: Math.max(0, Math.min(railBox.x, frameBox.x) - pad),
    y: Math.max(0, top - pad),
    width:
      Math.max(railBox.x + railBox.width, frameBox.x + frameBox.width) -
      Math.min(railBox.x, frameBox.x) +
      pad * 2,
    height: Math.max(railBox.y + railBox.height, frameBox.y + frameBox.height) - top + pad * 2,
  };
  const hoverPath = testInfo.outputPath("message-hover-toolbar.png");
  await page.screenshot({
    animations: "disabled",
    caret: "hide",
    clip,
    path: hoverPath,
  });
  await testInfo.attach("message-hover-toolbar", { contentType: "image/png", path: hoverPath });

  await react.click();
  for (const emoji of ["👍", "👎", "❤️", "😂", "🎉", "😮"]) {
    await expect(page.getByRole("button", { name: emoji, exact: true })).toBeVisible();
  }
  await captureScreenshot(page, testInfo, "message-reaction-picker");
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toHaveText("❤️");
  await parentRow.hover();
  await react.click();
  await page.getByRole("button", { name: "👍", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toContainText("👍");
  await parentRow.hover();
  await react.click();
  await page.getByRole("button", { name: "❤️", exact: true }).click();
  await expect(parentRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await captureScreenshot(page, testInfo, "message-multiple-reactions");
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(parentRow.getByTestId("message-reactions")).toContainText("❤️ 2");
  await expect(parentRow.getByTestId("message-reactions")).toContainText("👍");

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Copy" }).click();
  await expect
    .poll(async () => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(parentText);
  const copyConfirmation = toolbar.getByRole("button", { name: "Copied", exact: true });
  await expect(copyConfirmation).toBeVisible();
  await expect(copyConfirmation).toBeFocused();
  await expect(copyConfirmation).toHaveAttribute("aria-expanded", "false");
  await captureScreenshot(page, testInfo, "message-copy-confirmation");

  await parentRow.hover();
  await toolbar.getByRole("button", { name: "Reply" }).click();
  const replyChip = page.getByTestId("reply-chip");
  await expect(replyChip).toBeVisible();
  await expect(replyChip).toContainText(parentText);

  await sendComposerMessage(page, composer, replyText);
  await expect(replyChip).toHaveCount(0);

  const replyRow = transcript.locator(`[data-message-id]`).filter({ hasText: replyText }).first();
  await expect(replyRow).toBeVisible({ timeout: 20_000 });
  const parentPreview = replyRow.getByTestId("reply-parent-preview");
  await expect(parentPreview).toBeVisible();
  await expect(parentPreview).toContainText(parentText);
  // The reply line sits above the bubble; the rail centers on the bubble, not the pair.
  const replyRail = await revealHoverRail(replyRow);
  const replyBubble = replyRow.getByTestId("message-user-bubble");
  await expect
    .poll(async () => {
      const railBox = await replyRail.boundingBox();
      const bubbleBox = await replyBubble.boundingBox();
      if (!railBox || !bubbleBox) return null;
      return Math.abs(railBox.y + railBox.height / 2 - (bubbleBox.y + bubbleBox.height / 2));
    })
    .toBeLessThan(2);
  await expect(transcript.getByTestId("time-separator").first()).toContainText(/Today/);
  await captureScreenshot(page, testInfo, "message-reply-thread");

  await parentPreview.click();
  await expect(parentRow).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await botRow.scrollIntoViewIfNeeded();
  await revealHoverRail(botRow);
  await captureScreenshot(page, testInfo, "message-bot-actions-mobile");
  await parentRow.scrollIntoViewIfNeeded();
  await revealHoverRail(parentRow);
  await captureScreenshot(page, testInfo, "message-user-actions-mobile");
  await page.setViewportSize({ width: 1280, height: 812 });
  await expect(page.getByTestId("bots-sidebar")).toBeVisible();
  await page.getByTestId("bot-settings-trigger").hover({ trial: true });
  await expectHeaderAboveHoveredRow(page, testInfo, parentRow);
});

test("a message with an attachment centers hover actions on its text bubble", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `hover-attach-${stamp}@rakazo.test`, "password12", "Hover Attach");
  await completeOnboarding(page);
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await page.locator('input[type="file"]').setInputFiles({
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("meeting notes"),
  });
  await expect(page.getByRole("button", { name: "Remove notes.txt" })).toBeVisible();
  const text = `hover-attach-${stamp}`;
  await sendComposerMessage(page, composer, text);

  const row = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ hasText: text })
    .first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row.getByText("notes.txt")).toBeVisible();
  // Blocks in one message keep the same gap as separate messages instead of touching.
  // Poll: the bot's reply can land and scroll the transcript between the two measurements.
  // Text files preview in place, so the card carries Preview and Download buttons; the
  // preview button is the card body the gap is measured from.
  await expect
    .poll(async () => {
      const bubbleBox = await row.getByTestId("message-user-bubble").boundingBox();
      const fileBox = await row.getByRole("button", { name: "Preview notes.txt" }).boundingBox();
      return bubbleBox && fileBox ? fileBox.y - (bubbleBox.y + bubbleBox.height) : null;
    })
    .toBeGreaterThanOrEqual(6);
  const rail = await revealHoverRail(row);
  const bubble = row.getByTestId("message-user-bubble");
  await expect
    .poll(async () => {
      const railBox = await rail.boundingBox();
      const bubbleBox = await bubble.boundingBox();
      if (!railBox || !bubbleBox) return null;
      return Math.abs(railBox.y + railBox.height / 2 - (bubbleBox.y + bubbleBox.height / 2));
    })
    .toBeLessThan(2);
  await captureScreenshot(page, testInfo, "message-attachment-actions-desktop");
});

test.describe("touch message actions", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("More exposes actions without simulated hover", async ({ page }, testInfo) => {
    await signup(page, `touch-actions-${Date.now()}@rakazo.test`, "password12", "Touch Actions");
    await completeOnboarding(page);
    expect(
      await page.evaluate(() => matchMedia("(hover: hover) and (pointer: fine)").matches),
    ).toBe(false);
    await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: /Day-to-day work/ }).click();
    const botText = page.getByText(/Got it\./);
    await expect(botText).toBeVisible({ timeout: 20_000 });
    const row = page
      .getByTestId("transcript")
      .locator("[data-message-id]")
      .filter({ has: botText })
      .first();
    const rail = row.getByTestId("message-hover-rail");
    await expect(rail).toHaveCSS("opacity", "1");
    await expect(rail.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
    const botBubble = row.getByTestId("message-bot-bubble").first();
    const bubbleBox = await botBubble.boundingBox();
    const railBox = await rail.boundingBox();
    expect(bubbleBox).not.toBeNull();
    expect(railBox).not.toBeNull();
    expect(railBox!.y).toBeGreaterThanOrEqual(bubbleBox!.y + bubbleBox!.height - 1);
    expect(railBox!.x - bubbleBox!.x).toBeLessThan(8);
    await expectNoTouchSideGutter(row.getByTestId("message-bubble-frame"));
    await captureScreenshot(page, testInfo, "message-actions-touch-row");
    await rail.getByRole("button", { name: "React", exact: true }).tap();
    await expect(page.getByRole("button", { name: "🎉", exact: true })).toBeVisible();
    await captureScreenshot(page, testInfo, "message-reaction-picker-touch");
    await page.getByRole("button", { name: "🎉", exact: true }).tap();
    await expect(row.getByTestId("message-reactions")).toHaveText("🎉");
    await rail.getByRole("button", { name: "React", exact: true }).tap();
    await page.getByRole("button", { name: "🎉", exact: true }).tap();
    await expect(row.getByTestId("message-reactions")).toHaveText("🎉 2");
    await rail.getByRole("button", { name: "More" }).tap();
    await expect(page.getByRole("menuitem", { name: "Copy" })).toBeVisible();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("menu").locator("time")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "message-actions-touch-menu");
    await page.keyboard.press("Escape");
    const composer = page.getByRole("combobox", { name: /^Message/ });
    await sendComposerMessage(page, composer, `touch-width-${Date.now()}`);
    const userRow = page.locator("[data-message-id]").filter({ hasText: "touch-width-" }).first();
    await expect(userRow).toBeVisible({ timeout: 20_000 });
    await expectNoTouchSideGutter(userRow.getByTestId("message-bubble-frame"));
    await rail.scrollIntoViewIfNeeded();
    await rail.getByRole("button", { name: "Reply", exact: true }).tap();
    await expect(page.getByRole("button", { name: "Cancel reply" })).toBeVisible();
  });
});

test("a reaction receipt refreshes live work and exposes Stop", async ({ page }, testInfo) => {
  await signup(page, `reaction-work-${Date.now()}@rakazo.test`, "password12", "Reaction Work");
  await completeOnboarding(page);
  await expect(page.getByText("What do you want me on first?", { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  await page.getByRole("button", { name: /Day-to-day work/ }).click();
  const botText = page.getByText(/Got it\./);
  await expect(botText).toBeVisible({ timeout: 20_000 });
  const row = page
    .getByTestId("transcript")
    .locator("[data-message-id]")
    .filter({ has: botText })
    .first();
  const botId = activeBotId(page);
  let reacted = false;
  // No run events are emitted: the receipt alone must refresh the active state.
  await page.route("**/rpc/threads/react", async (route) => {
    reacted = true;
    await route.fulfill({ json: { json: { ok: true, runIds: ["reaction-run"] } } });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (reacted) {
      const run = {
        id: "reaction-run",
        botId,
        threadId: body.json.threadId,
        taskId: "reaction-task",
        status: "running",
        trigger: "reaction",
        routineId: null,
        modelProvider: null,
        modelId: null,
        error: null,
        startedAt: new Date().toISOString(),
        completedAt: null,
        createdAt: new Date().toISOString(),
      };
      body.json.run = run;
      body.json.activeRuns = [run];
    }
    await route.fulfill({ response, json: body });
  });
  const rail = await revealHoverRail(row);
  await rail.getByRole("button", { name: "React" }).click();
  await page.getByRole("button", { name: "🎉", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "reaction-run-working");
});
