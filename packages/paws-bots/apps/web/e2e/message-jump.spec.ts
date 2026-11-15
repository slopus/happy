import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("a ?m= deep link jumps while the thread is streaming", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `jump-${stamp}@rakazo.test`, "password12", "Jump Tester");
  await completeOnboarding(page);

  const botId = activeBotId(page);
  const transcript = page.getByTestId("transcript");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const rows = transcript.locator("[data-message-id]");

  const targetText = `jump-target-${stamp}`;
  await composer.fill(targetText);
  await composer.press("Enter");
  const targetRow = rows
    .filter({ has: page.getByTestId("message-user-bubble") })
    .filter({ hasText: targetText })
    .first();
  await expect(targetRow).toBeVisible({ timeout: 20_000 });
  const messageId = await targetRow.getAttribute("data-message-id");
  if (!messageId) throw new Error("missing data-message-id");

  // Flood the thread: every successful send steers the run, so SSE events keep
  // committing urgent updates — the churn that previously starved the router's
  // navigation transition. Only completed sends count; a flood that cannot
  // land makes the streaming precondition below fail instead of passing
  // vacuously.
  let flooding = true;
  let sent = 0;
  const flood = Promise.all(
    Array.from({ length: 3 }, async (_, lane) => {
      let i = 0;
      while (flooding) {
        const nonce = `jf-${stamp}-${lane}-${i++}`;
        try {
          await rpc(page, "threads/send", {
            botId,
            text: `jump-flood-${stamp}-${lane}-${i}`,
            clientNonce: nonce,
          });
          sent++;
        } catch {
          // A rejected send contributes no churn; keep flooding and let the
          // precondition decide whether enough landed.
        }
      }
    }),
  );
  try {
    // Precondition: the stream is really committing — rows keep appearing.
    const rowsBefore = await rows.count();
    await expect.poll(() => rows.count(), { timeout: 20_000 }).toBeGreaterThan(rowsBefore);

    await expect(targetRow).not.toBeInViewport({ timeout: 20_000 });
    const sentAtPush = sent;

    const aroundJump = page.waitForResponse(
      (response) =>
        response.url().includes("/rpc/threads/messages") &&
        (response.request().postData() ?? "").includes('"around"'),
      { timeout: 15_000 },
    );
    await page.evaluate((id) => {
      history.pushState({}, "", `?m=${id}`);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }, messageId);
    // The jump's finally strips this one-shot param as soon as the around-fetch
    // settles. toHaveURL only samples the current URL, so under load the first
    // poll can already miss ?m= and then retry a value that will not return.
    // The around response is the proof the router observed the deep link.

    // The jump lands mid-stream: the around-page fetch succeeds while sends
    // keep landing, and the target scrolls back into view. (The transcript
    // unfollows the tail for a jump; before that, follow commits could cancel
    // the scroll — asserting the viewport also guards that path.)
    const aroundResponse = await aroundJump;
    expect(aroundResponse.ok()).toBe(true);
    await expect.poll(() => sent, { timeout: 10_000 }).toBeGreaterThan(sentAtPush);
    await expect(targetRow).toBeInViewport({ timeout: 20_000 });
    // The one-shot param is stripped so a refresh does not re-jump.
    await expect(page).not.toHaveURL(/[?&]m=/, { timeout: 20_000 });

    // All regression assertions above run under continuous sends. Stop only the
    // unbounded producer before taking the artifact, so screenshot rendering
    // does not compete with an ever-growing transcript. The run stops in finally.
    flooding = false;
    await flood;
    await captureScreenshot(page, testInfo, "message-jump-during-stream");
  } finally {
    flooding = false;
    await flood;
    await rpc(page, "threads/stop", { botId }).catch(() => {});
  }
});

test("the chat follows your sends and a reader at the bottom, not a reader who scrolled away", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const stamp = Date.now();
  await signup(page, `follow-${stamp}@rakazo.test`, "password12", "Follow Tester");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await rpc(page, "onboarding/dismissFocus", { botId });

  const transcript = page.getByTestId("transcript");
  const rows = transcript.locator("[data-message-id]");
  const composer = page.getByRole("combobox", { name: /Message/ });
  const jumpToLatest = page.getByRole("button", { name: "Jump to latest" });
  const userBubble = (text: string) =>
    transcript.getByTestId("message-user-bubble").filter({ hasText: text });
  const gapToEnd = () =>
    transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const scrollTop = () => transcript.evaluate((el) => el.scrollTop);
  const send = async (text: string) => {
    await composer.fill(text);
    await composer.press("Enter");
  };
  for (let item = 1; item <= 8; item++) {
    const text = `Earlier note ${item}: the draft is reviewed and the checklist is complete.`;
    await send(text);
    await expect(userBubble(text)).toBeInViewport();
  }
  // Five lines plus the reply grow the chat well past the near-end band.
  const long = (tag: string) =>
    `work for 1 second ${tag}\nline two\nline three\nline four\nline five`;
  const arrive = (tag: string) =>
    rpc(page, "threads/send", { botId, text: long(tag), clientNonce: `${tag}-${stamp}` });
  const replied = async (tag: string) => {
    await expect(userBubble(tag)).toBeAttached({ timeout: 20_000 });
    await expect
      .poll(() =>
        rows.last().evaluate((el, tag) => {
          const text = el.textContent ?? "";
          return !text.includes(tag) && text.includes("done.");
        }, tag),
      )
      .toBe(true);
  };
  const followed = async (tag: string) => {
    await replied(tag);
    await expect(userBubble(tag)).toBeInViewport();
    await expect.poll(gapToEnd).toBeLessThan(2);
  };
  const scrollAway = async () => {
    await transcript.hover();
    await page.mouse.wheel(0, -1_500);
    await expect(jumpToLatest).toBeVisible();
  };
  const resetToEnd = async () => {
    await transcript.hover();
    await page.mouse.wheel(0, 20_000);
    await expect.poll(gapToEnd).toBeLessThan(2);
    await expect(jumpToLatest).toBeHidden();
  };

  // Your own send brings you back from anywhere, like mobile.
  await scrollAway();
  await send(long(`own send ${stamp}`));
  await followed(`own send ${stamp}`);
  await expect(jumpToLatest).toBeHidden();
  await captureScreenshot(page, testInfo, "transcript-follows-own-send");

  // Scrolling away while your send is still on its way keeps your place.
  await resetToEnd();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/rpc/threads/send", async (route) => {
    await held;
    await route.continue();
  });
  await send(long(`slow send ${stamp}`));
  await scrollAway();
  let top = await scrollTop();
  release();
  await replied(`slow send ${stamp}`);
  await page.unroute("**/rpc/threads/send");
  expect(await scrollTop()).toBe(top);
  await expect(jumpToLatest).toBeVisible();

  // A click or selection drag at the bottom, even released over the composer, is not scrolling away.
  await resetToEnd();
  const box = await userBubble(`own send ${stamp}`).boundingBox();
  const target = await composer.boundingBox();
  if (!box || !target) throw new Error("missing layout");
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + 20, target.y + target.height / 2, { steps: 5 });
  await page.mouse.up();
  // The refresh after the reply's run ends would also pull a near-end reader down.
  const refreshed = page.waitForResponse((response) => response.url().includes("/rpc/threads/get"));
  await arrive(`after a drag ${stamp}`);
  await followed(`after a drag ${stamp}`);
  await refreshed;

  // Nor is a small nudge that stays near the end.
  await resetToEnd();
  // One upward wheel step and one scroll, so only its scrollend can turn following back on.
  await transcript.evaluate((el) => {
    el.addEventListener("scrollend", () => el.setAttribute("data-scrolled", ""), { once: true });
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: -20, bubbles: true }));
    el.scrollTop -= 20;
  });
  await expect(transcript).toHaveAttribute("data-scrolled", "");
  expect(await gapToEnd()).toBeGreaterThan(0);
  await arrive(`after a nudge ${stamp}`);
  await followed(`after a nudge ${stamp}`);

  // Messages you did not send leave a reader who scrolled away in place.
  await resetToEnd();
  await scrollAway();
  top = await scrollTop();
  await arrive(`while reading ${stamp}`);
  await replied(`while reading ${stamp}`);
  expect(await scrollTop()).toBe(top);
  await expect(jumpToLatest).toBeVisible();

  // A jump that lands at the end keeps its place while new messages arrive.
  const jumpRow = rows.filter({
    has: page.getByTestId("message-user-bubble").filter({ hasText: `while reading ${stamp}` }),
  });
  const messageId = await jumpRow.getAttribute("data-message-id");
  const around = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/threads/messages") &&
      (response.request().postData() ?? "").includes('"around"'),
  );
  await transcript.evaluate((el) =>
    el.addEventListener("scrollend", () => el.setAttribute("data-jumped", ""), { once: true }),
  );
  await page.evaluate((id) => {
    history.pushState({}, "", `?m=${id}`);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, messageId);
  await around;
  await expect(page).not.toHaveURL(/[?&]m=/);
  await expect.poll(gapToEnd).toBeLessThan(80);
  await expect(transcript).toHaveAttribute("data-jumped", "");
  top = await scrollTop();
  await arrive(`after a jump ${stamp}`);
  await replied(`after a jump ${stamp}`);
  expect(await scrollTop()).toBe(top);
  await expect(jumpRow).toBeInViewport();
  await expect(jumpToLatest).toBeVisible();
});
