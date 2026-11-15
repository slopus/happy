import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("shows peer lines in transcript and opens view-only peer chat", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `peer-msg-${stamp}@rakazo.test`, "password12", "Peer Msg");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chiefId = activeBotId(page);
  await rpc(page, "bots/create", {
    name: "Researcher",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible();

  const composer = page.getByRole("combobox", { name: "Message Chief" });
  await composer.fill("message the bot named Researcher saying peer-exchange-alpha");
  await composer.press("Enter");

  await expect
    .poll(
      async () => {
        const history = await rpc<{
          messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
        }>(page, "threads/messages", { botId: chiefId, includePeerRuns: true });
        const peerTexts = history.messages.flatMap((message) =>
          message.blocks
            .filter(
              (block) => block.kind === "bot_message_sent" || block.kind === "bot_message_received",
            )
            .map((block) => block.text ?? ""),
        );
        return peerTexts.some((text) => text.includes("peer-exchange-alpha"));
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });

  const transcript = page.getByTestId("transcript");
  const chip = transcript
    .getByTestId("peer-receipt-chip")
    .filter({ hasText: "Researcher" })
    .first();
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip.getByText(/Messaged|Message from|messages with/)).toBeVisible();
  await expect(chip).toHaveAccessibleName(
    /Messaged Researcher|Message from Researcher|messages with Researcher/,
  );
  await expect(chip.locator(".rakazo-organic-avatar")).toBeVisible();
  await expect(chip).not.toContainText("{peer}");
  // User bubble still contains the phrase; peer body must not appear outside the chip.
  await expect(chip).not.toContainText("peer-exchange-alpha");
  // Only the user's ask and Chief's own relay of Researcher's result carry the phrase.
  await expect(transcript.getByText(/^Here's what Researcher found: /)).toBeVisible({
    timeout: 60_000,
  });
  await expect(transcript.getByText("peer-exchange-alpha")).toHaveCount(2);
  const assertChipCentered = async () => {
    const transcriptBox = await transcript.boundingBox();
    const chipBox = await chip.boundingBox();
    expect(transcriptBox).not.toBeNull();
    expect(chipBox).not.toBeNull();
    const chipCenter = chipBox!.x + chipBox!.width / 2;
    const transcriptCenter = transcriptBox!.x + transcriptBox!.width / 2;
    expect(Math.abs(chipCenter - transcriptCenter)).toBeLessThanOrEqual(8);
    // Stay under 75% of the transcript width so the chip cannot become a full-width bar.
    expect(chipBox!.width).toBeLessThan(transcriptBox!.width * 0.75);
  };

  await assertChipCentered();
  await expect(composer).toBeVisible();
  await captureScreenshot(page, testInfo, "peer-chip-desktop");

  await page.setViewportSize({ width: 390, height: 844 });
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(composer).toBeVisible();
  await assertChipCentered();
  await captureScreenshot(page, testInfo, "peer-chip-mobile");

  await chip.focus();
  await expect(chip).toBeFocused();
  await chip.press("Enter");
  const view = page.getByTestId("peer-conversation-view");
  await expect(view).toBeVisible();
  await expect(view.getByRole("heading", { name: /Chief\s*Researcher/ })).toBeVisible();
  await expect(transcript.getByTestId("peer-replies-toggle")).toHaveCount(0);
  const close = view.getByRole("button", { name: "Close", exact: true });
  await expect(close).toHaveCount(1);
  await expect(close.locator("svg")).toBeVisible();
  await expect(close).toHaveText("");
  const assertHeaderLayout = async () => {
    // The dialog zooms in as it opens; boxes measured before that ends are scaled.
    await expect
      .poll(() =>
        // Only the popup's own animation: the header avatars animate without end.
        view.evaluate((dialog) =>
          dialog.getAnimations().every((animation) => animation.playState !== "running"),
        ),
      )
      .toBe(true);
    const viewBox = await view.boundingBox();
    const headingBox = await view.getByRole("heading").boundingBox();
    const buttonBox = await close.boundingBox();
    expect(viewBox).not.toBeNull();
    expect(headingBox).not.toBeNull();
    expect(buttonBox).not.toBeNull();
    expect(
      Math.abs(headingBox!.x + headingBox!.width / 2 - (viewBox!.x + viewBox!.width / 2)),
    ).toBeLessThanOrEqual(1);
    expect(headingBox!.x + headingBox!.width).toBeLessThanOrEqual(buttonBox!.x);
    const headerBox = await view.locator(":scope > div").first().boundingBox();
    expect(headerBox).not.toBeNull();
    expect(headerBox!.y).toBe(viewBox!.y);
    expect(buttonBox!.y).toBeLessThan(viewBox!.y + 24);
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(headerBox!.y + headerBox!.height);
    expect(viewBox!.x + viewBox!.width - (buttonBox!.x + buttonBox!.width)).toBeLessThan(24);
  };
  await assertHeaderLayout();
  await expect(view.getByText("peer-exchange-alpha").first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(view.getByRole("textbox")).toHaveCount(0);
  await expect(view.getByRole("status", { name: "Loading…", exact: true })).toHaveCount(0);
  const peerTranscript = view.getByTestId("peer-conversation-transcript");
  await expect
    .poll(() =>
      peerTranscript.evaluate(
        (element) => element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
      ),
    )
    .toBe(true);
  expect(
    await peerTranscript.evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await captureScreenshot(page, testInfo, "peer-view-only");

  await close.click();
  await expect(view).toHaveCount(0);
  await page.setViewportSize({ width: 1800, height: 900 });
  const regularContentWidth = await transcript.evaluate((element) => {
    const style = getComputedStyle(element);
    return (
      element.clientWidth -
      Number.parseFloat(style.paddingLeft) -
      Number.parseFloat(style.paddingRight)
    );
  });
  const assertPeerWidth = async () => {
    const layout = await peerTranscript.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        width:
          element.clientWidth -
          Number.parseFloat(style.paddingLeft) -
          Number.parseFloat(style.paddingRight),
        left: Number.parseFloat(style.paddingLeft),
        right: Number.parseFloat(style.paddingRight),
      };
    });
    expect(layout.width).toBeLessThanOrEqual(regularContentWidth + 1);
    expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(1);
    expect(layout.left).toBeGreaterThan(regularContentWidth / 4);
    await assertHeaderLayout();
  };
  await page.evaluate(() => {
    const state = {
      phase: "idle",
      currentVersion: "0.1.0",
      availableVersion: null,
      percent: null,
      message: null,
      checkedAt: null,
    };
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "darwin",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => state,
          check: async () => state,
          download: async () => state,
          install: async () => {},
        },
      },
    });
  });
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(view).toBeVisible();
  const avatarsLeft = await view
    .getByRole("heading")
    .evaluate((heading) => heading.getBoundingClientRect().left);
  // macOS draws the traffic lights from x=16 to about x=68 in the window's top-left corner.
  expect(avatarsLeft).toBeGreaterThan(80);
  await assertPeerWidth();
  await captureScreenshot(page, testInfo, "peer-view-only-macos-desktop");
});

const foldedReplyText = "on it. i will work this in the background";
const relayText = "Here's what Researcher found: done. i handled: peer-fold-alpha";

/**
 * Chief messages Researcher. Chief relays Researcher's result to the user as its own reply, under
 * its "Messaged Researcher" receipt; Researcher's own work on Chief's request folds under its
 * marker in Researcher's chat.
 */
async function openFoldedPeerReply(page: Page, name: string, testInfo: TestInfo) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Peer Fold");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  const chiefComposer = page.getByRole("combobox", { name: "Message Chief" });
  await chiefComposer.fill("message the bot named Researcher saying peer-fold-alpha");
  await chiefComposer.press("Enter");

  // Researcher's result wakes Chief, which relays it to the user as an ordinary reply. Its
  // marker merges into the "Messaged Researcher" receipt, which already opens the exchange.
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText(relayText)).toBeVisible({ timeout: 60_000 });
  await expect(transcript.getByText("messaging that bot now.")).toBeVisible();
  await expect(
    transcript.getByTestId("peer-receipt-chip").filter({ hasText: "Messaged Researcher" }),
  ).toBeVisible();
  await expect(
    transcript.getByTestId("peer-receipt-chip").filter({ hasText: "Message from Researcher" }),
  ).toHaveCount(0);
  // Researcher's own words stay in the exchange; only Chief's relay reaches the user.
  await expect(transcript.getByText(foldedReplyText)).toHaveCount(0);
  await expect(transcript.getByTestId("message-bot-bubble").last()).toContainText(relayText);
  await captureScreenshot(page, testInfo, "peer-result-relay-inline");

  // Researcher's reply to Chief's request is bot-to-bot work: it folds in Researcher's chat.
  await page.goto(`/app/${researcher.id}`);
  await expect(
    transcript
      .getByTestId("peer-receipt-chip")
      .filter({ hasText: /Message from Chief|messages with Chief/ }),
  ).toBeVisible({ timeout: 60_000 });
  const reply = transcript.getByText(foldedReplyText);
  await expect(reply).toHaveCount(0);
  return { researcher, chiefComposer, transcript, reply };
}

test(
  "folds a peer run's reply under its marker and keeps its ask inline",
  { tag: "@nightly" },
  async ({ page }, testInfo) => {
    const { researcher, chiefComposer, transcript, reply } = await openFoldedPeerReply(
      page,
      "peer-fold",
      testInfo,
    );

    const line = transcript.getByTestId("peer-receipt-chip").filter({ hasText: "Chief" }).first();
    await expect(transcript.getByTestId("peer-replies-toggle")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "peer-line-folded");
    await line.click();
    const view = page.getByTestId("peer-conversation-view");
    await expect(view).toBeVisible();
    await expect(view.getByText(foldedReplyText).first()).toBeVisible();
    await captureScreenshot(page, testInfo, "peer-line-read-only-chat");
    await view.getByRole("button", { name: "Close" }).click();

    // A search hit on a folded reply expands its marker and scrolls to it.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("sidebar-search-trigger").click();
    const search = page.getByTestId("sidebar-search").getByRole("textbox");
    await search.fill(foldedReplyText);
    // Researcher's "Messaged Chief" receipt also matches; jump to the folded reply itself.
    await page
      .getByRole("button")
      .filter({
        hasText: new RegExp(`Researcher\\s*${foldedReplyText} and come back with a result`),
      })
      .first()
      .click();
    await expect(reply).toBeInViewport();
    await captureScreenshot(page, testInfo, "peer-reply-search-jump");
    await expect(search).toHaveCount(0);

    // An ask from the woken run stays inline in the recipient's thread; its text folds.
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
    await page.goto("/app");
    await chiefComposer.fill("message the bot named Researcher saying which city peer-fold-beta");
    await chiefComposer.press("Enter");
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 60_000 });
    await page.goto(`/app/${researcher.id}`);
    const researcherTranscript = page.getByTestId("transcript");
    await expect(
      researcherTranscript.locator("p").filter({ hasText: /^Which city should I use\?$/ }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      researcherTranscript
        .getByTestId("peer-receipt-chip")
        .filter({ hasText: /Message from Chief|messages with Chief/ }),
    ).toHaveCount(2);
    await expect(
      researcherTranscript.getByText("i need a decision before i continue."),
    ).toHaveCount(0);

    // The user's answer joins the peer run but is not a bot reply, so it stays out of the fold.
    await page.getByRole("combobox", { name: "Message Researcher" }).fill("Paris");
    await page.getByRole("combobox", { name: "Message Researcher" }).press("Enter");
    await expect(
      researcherTranscript.getByTestId("message-user-bubble").filter({ hasText: /^Paris$/ }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(researcherTranscript.getByTestId("peer-replies-toggle")).toHaveCount(0);
    await captureScreenshot(page, testInfo, "peer-run-answer-inline");
  },
);

test("answers a message sent while the bot works on another bot's request", async ({
  page,
}, testInfo) => {
  await signup(page, `peer-busy-${Date.now()}@rakazo.test`, "password12", "Peer Busy");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  const chief = page.getByRole("combobox", { name: "Message Chief" });
  await chief.fill("message the bot named Researcher saying work for 8 seconds");
  await chief.press("Enter");

  // Researcher is busy with Chief's request when the user writes to it.
  await expect
    .poll(
      async () => {
        const history = await rpc<{ messages: Array<{ blocks: Array<{ kind: string }> }> }>(
          page,
          "threads/messages",
          { botId: researcher.id, includePeerRuns: true },
        );
        return history.messages.some((message) =>
          message.blocks.some((block) => block.kind === "bot_message_received"),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await page.goto(`/app/${researcher.id}`);
  const composer = page.getByRole("combobox", { name: "Message Researcher" });
  await composer.fill("remember peer-busy-alpha");
  await composer.press("Enter");

  const transcript = page.getByTestId("transcript");
  await expect(
    transcript.getByTestId("message-user-bubble").filter({ hasText: "peer-busy-alpha" }),
  ).toBeVisible({ timeout: 30_000 });
  // The message landed while Chief's request was still running, so it was held behind it.
  const held = await rpc<{
    messages: Array<{
      role: string;
      runId?: string;
      blocks: Array<{ kind: string; text?: string }>;
    }>;
  }>(page, "threads/messages", { botId: researcher.id, includePeerRuns: true });
  const peerRunId = held.messages.find((message) =>
    message.blocks.some((block) => block.kind === "bot_message_received"),
  )?.runId;
  const sent = held.messages.find((message) =>
    message.blocks.some((block) => block.text === "remember peer-busy-alpha"),
  );
  expect(peerRunId).toBeTruthy();
  expect(sent?.runId).toBe(peerRunId);
  // The answer is the user's own: inline in the chat, never folded under Chief's request.
  const answer = transcript.getByText("i will keep that in memory.");
  await expect(answer).toBeVisible({ timeout: 60_000 });
  await captureScreenshot(page, testInfo, "peer-busy-answer-inline");

  // Only Chief's request goes back to Chief, not the answer to the user.
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  // Chief relays Researcher's result as its own reply; the result's marker merges into the
  // "Messaged Researcher" receipt.
  const chiefTranscript = page.getByTestId("transcript");
  await expect(
    chiefTranscript.getByText("Here's what Researcher found: done.", { exact: true }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    chiefTranscript.getByTestId("peer-receipt-chip").filter({ hasText: "Message from Researcher" }),
  ).toHaveCount(0);
  const returned = await rpc<{
    messages: Array<{ blocks: Array<{ kind: string; text?: string }> }>;
  }>(page, "threads/messages", { botId: researcher.id, includePeerRuns: true });
  const sentToChief = returned.messages.flatMap((message) =>
    message.blocks.filter((block) => block.kind === "bot_message_sent").map((b) => b.text ?? ""),
  );
  expect(sentToChief.some((text) => text.includes("keep that in memory"))).toBe(false);
});
