import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "./helpers";

test("a page chip in a right-to-left chat keeps its icon gap on the text side", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `page-chip-rtl-${stamp}@rakazo.test`, "password12", "Locale QA");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/[^/]+$/);
  const botId = activeBotId(page);

  // A bot message that links a page renders the chip with its icon and title.
  // The chat paints from the bootstrap payload and refreshes through
  // threads/get; inject the message into whichever serves the thread.
  const withPageChipMessage = (snap: Record<string, unknown>) => {
    const messages = (snap.messages as unknown[]) ?? [];
    if (messages.some((message) => (message as { id?: string }).id === "msg-page-chip-rtl"))
      return snap;
    return {
      ...snap,
      messages: [
        ...messages,
        {
          id: "msg-page-chip-rtl",
          threadId: snap.threadId,
          seq: Math.max(Number(snap.cursor ?? 0), 0) + 1,
          role: "bot",
          botId,
          blocks: [{ kind: "text", text: "ראה [Sales](page:page_1)" }],
          createdAt: new Date().toISOString(),
        },
      ],
    };
  };
  await page.route(/\/rpc\/(bootstrap|threads\/get)$/, async (route) => {
    const response = await route.fetch();
    const parsed = (await response.json()) as { json?: Record<string, unknown> };
    const json = parsed.json;
    if (!json) {
      await route.fulfill({ response });
      return;
    }
    const thread = json.thread as Record<string, unknown> | undefined;
    if (thread?.threadId) json.thread = withPageChipMessage(thread);
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
  });

  const settings = await openUserSettings(page);
  await settings.getByTestId("ui-locale-select").click();
  await page.getByRole("option", { name: "עברית", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const chipRow = page.locator('[data-message-id="msg-page-chip-rtl"]');
  await expect(chipRow).toBeVisible({ timeout: 20_000 });
  const chip = chipRow.locator(".rk-chat-page-chip").first();
  await expect(chip).toBeVisible();
  const gap = await chip.evaluate((element) => {
    const icon = element.querySelector<HTMLElement>(".rk-chat-page-chip-icon");
    const title = element.querySelector<HTMLElement>(".rk-chat-page-chip-title");
    if (!icon || !title) throw new Error("chip parts missing");
    const iconBox = icon.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return Math.round(
      Math.max(iconBox.left, titleBox.left) - Math.min(iconBox.right, titleBox.right),
    );
  });
  // The 7px gap must sit between the icon and the title, whichever side the
  // text flows from; a physical margin leaves them touching in RTL.
  expect(gap).toBeGreaterThan(2);
  await captureScreenshot(page, testInfo, "ui-locale-page-chip-he");
});
