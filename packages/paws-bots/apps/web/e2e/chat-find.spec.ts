import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("the desktop app finds text in the open chat", async ({ page }, testInfo) => {
  // Browsers keep Cmd/Ctrl+F for their own find, so the bar belongs to the desktop app.
  await page.addInitScript(() => {
    Object.defineProperty(window, "rakazoDesktop", {
      value: {
        platform: "linux",
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
      },
    });
  });
  await signup(page, `find-${Date.now()}@rakazo.test`, "password12", "Find Chat");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const composer = page.getByRole("combobox", { name: /^Message / });
  await composer.fill("Remember the zephyrine launch window");
  await page.keyboard.press("Enter");
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText(/zephyrine launch window/).first()).toBeVisible();

  await page.keyboard.press("ControlOrMeta+F");
  const find = page.getByRole("searchbox", { name: "Find in chat" });
  await expect(find).toBeFocused();
  await find.fill("ZEPHYRINE");
  const bar = page.getByTestId("chat-find");
  await expect(bar.getByText(/^1\/\d+$/)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => CSS.highlights.get("rk-find-current")?.size ?? 0))
    .toBe(1);
  await captureScreenshot(page, testInfo, "chat-find");

  await page.keyboard.press("Escape");
  // User bubbles are literal text. Seed assistant markdown through the same thread
  // responses the open chat normally reads; a text fence would wrap as prose.
  await page.route(/\/rpc\/(bootstrap|threads\/get)$/, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const thread = body.json?.thread ?? body.json;
    if (thread?.threadId) {
      thread.messages.push({
        id: "msg-find-long-code",
        threadId: thread.threadId,
        seq: Number(thread.cursor ?? 0) + 1,
        role: "bot",
        botId: thread.botId,
        blocks: [
          {
            kind: "text",
            text: `\`\`\`ts\nhorizfindneedle\n${"long-code-".repeat(100)}horizfindneedle\n\`\`\``,
          },
        ],
        createdAt: new Date().toISOString(),
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const code = transcript.locator("pre").filter({ hasText: "horizfindneedle" }).first();
  await expect(code).toBeVisible();
  await expect
    .poll(() => code.evaluate((element) => element.scrollWidth > element.clientWidth))
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+F");

  for (const direction of ["ltr", "rtl"]) {
    await code.evaluate((element, dir) => {
      element.setAttribute("dir", dir);
      element.scrollLeft = 0;
    }, direction);
    await find.fill("");
    await find.fill("horizfindneedle");
    await expect(bar.getByText("1/2")).toBeVisible();
    for (const button of ["Next match", "Previous match", "Next match"]) {
      await bar.getByRole("button", { name: button }).click();
      await expect(bar.getByText(button === "Previous match" ? "1/2" : "2/2")).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const range = CSS.highlights.get("rk-find-current")?.values().next().value;
            const pre = range?.startContainer.parentElement?.closest("pre");
            if (!(range instanceof Range) || !pre) return false;
            const match = range.getBoundingClientRect();
            const view = pre.getBoundingClientRect();
            const transcript = pre.closest('[data-testid="transcript"]');
            if (!transcript) return false;
            const outer = transcript.getBoundingClientRect();
            return (
              match.left >= view.left - 1 &&
              match.right <= view.right + 1 &&
              match.top >= outer.top - 1 &&
              match.bottom <= outer.bottom + 1
            );
          }),
        )
        .toBe(true);
    }
  }
  await captureScreenshot(page, testInfo, "chat-find-long-code");

  await find.fill("no such words anywhere");
  await expect(bar.getByText("0/0")).toBeVisible();
  await expect(bar.getByRole("button", { name: "Next match" })).toBeDisabled();

  await page.keyboard.press("Escape");
  await expect(bar).toBeHidden();
  await expect.poll(() => page.evaluate(() => CSS.highlights.get("rk-find")?.size ?? 0)).toBe(0);
  await expect(composer).toBeFocused();
});
