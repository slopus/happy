import type { Page, Route } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openBotPanelTab,
  rpc,
  signup,
} from "./helpers";

function dashboard(churn: string) {
  return `const data = { signups: [42, 51, 47, 63, 58, 71, 66], labels: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] };
function Dashboard() {
  const [period, setPeriod] = useState("7d");
  const [targets, setTargets] = useState(false);
  const points = useMemo(() => data.signups.map((value, i) => ({ label: data.labels[i], value })), []);
  return (
    <Page width="wide" title="Test dashboard" summary="A sample dashboard with made-up example data, to show what a Page looks like and how its controls work.">
      <Section heading="Headline figures">
        <Segmented options={[{ value: "7d", label: "Last 7 days" }, { value: "30d", label: "Last 30 days" }]} value={period} onChange={setPeriod} />
        <Text>All numbers here are example data, not real metrics. Method: https://example.com/metrics</Text>
        <ReplyButton label="Ask about churn" reply="Why did churn change this week?" />
        <CopyButton label="Copy MRR" text="MRR $12,400" />
        <Toggle label={targets ? "Targets shown" : "Show targets"} value={targets} onChange={setTargets} />
        <Metrics metrics={[{ value: "$12,400", label: "MRR" }, { value: "398", label: "New users" }, { value: "${churn}", label: "Churn", tone: "warning" }, { value: "4.8%", label: "Trial to paid" }]} />
      </Section>
      <Grid columns={2}>
        <Section heading="Signups over time"><LineChart points={points} ceiling={86} floor={0} labels={["Signups"]} /></Section>
        <Section heading="Signups by source"><Bars bars={[{ label: "Organic search", value: 46, display: "46%" }, { label: "Direct", value: 24, display: "24%" }]} emphasis={0} /></Section>
      </Grid>
    </Page>
  );
}
export default Dashboard;`;
}

/** The page document, two sandboxed frames down. */
function pageFrame(page: Page, title: string) {
  return page
    .locator(`iframe[title="${title}"]`)
    .last()
    .contentFrame()
    .locator("iframe#preview")
    .contentFrame();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill(text);
  await composer.press("Enter");
}

test("a week calendar keeps its days aligned in a desktop two-column page", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-calendar-${Date.now()}@rakazo.test`, "password12", "Calendar Reader");
  await completeOnboarding(page);
  const title = "Calendar layout";
  const source = `function CalendarPage() {
    return <Page width="wide" title="Calendar layout">
      <Grid columns={2}>
        <Section heading="Week"><WeekView week="2026-11-09" events={[
          { date: "2026-11-09", start: 9, end: 10, title: "Monday event" },
          { date: "2026-11-15", start: 9.5, end: 10.5, title: "Sunday event" },
          { date: "2026-11-16", start: 22, end: 23, title: "Next week event" }
        ]} /></Section>
        <Section heading="Day"><DayView start={8} end={18} events={[
          { start: 9.5, end: 10.5, title: "Day event" }
        ]} /></Section>
      </Grid>
    </Page>;
  }
  export default CalendarPage;`;
  await send(page, `call save_page with ${JSON.stringify({ title, source })}\nthen say Done.`);
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();
  const frame = pageFrame(page, title);
  await expect(frame.getByText("Sunday event")).toBeAttached();
  const layout = await frame.locator(".rk-grid").evaluate((grid) => {
    const cards = [...grid.querySelectorAll(":scope > .rk-section")];
    const week = cards[0]!.querySelector(".rk-cal-timed")!;
    const day = cards[1]!.querySelector(".rk-cal-timed")!;
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width };
    };
    const heads = [...week.querySelectorAll(".rk-cal-head")].map(rect);
    const columns = [...week.querySelectorAll(".rk-cal-column")].map(rect);
    const sunday = week.querySelector(".rk-cal-column:last-child .rk-cal-event")!;
    const dayColumns = [...day.querySelectorAll(".rk-cal-column")].map(rect);
    return {
      cards: cards.map(rect),
      heads,
      columns,
      weekGrid: rect(week.querySelector(".rk-cal-columns")!),
      weekHeight: week.querySelector(".rk-cal-body")!.getBoundingClientRect().height,
      weekScroll: { client: week.clientWidth, scroll: week.scrollWidth },
      sunday: rect(sunday),
      sundayText: sunday.textContent,
      dayColumns,
      dayGrid: rect(day.querySelector(".rk-cal-columns")!),
      dayEvent: rect(day.querySelector(".rk-cal-event")!),
      dayText: day.querySelector(".rk-cal-event")!.textContent,
    };
  });
  expect(layout.cards).toHaveLength(2);
  expect(layout.cards[1]!.x).toBeGreaterThan(layout.cards[0]!.x);
  expect(layout.cards[1]!.y).toBeCloseTo(layout.cards[0]!.y, 0);
  // The card is too narrow for seven 64px days, so the week scrolls inside it instead of
  // wrapping Sunday into a second row or spilling out of the card.
  expect(layout.weekScroll.scroll).toBeGreaterThan(layout.weekScroll.client);
  expect(layout.columns[6]!.x + layout.columns[6]!.width).toBeLessThanOrEqual(
    layout.weekGrid.x + layout.weekGrid.width + 1,
  );
  expect(layout.heads).toHaveLength(7);
  expect(layout.columns).toHaveLength(7);
  for (let i = 0; i < 7; i++) {
    expect(layout.columns[i]!.y).toBeCloseTo(layout.columns[0]!.y, 0);
    expect(Math.abs(layout.heads[i]!.x - layout.columns[i]!.x)).toBeLessThanOrEqual(1);
  }
  expect(layout.weekHeight).toBeCloseTo(88, 0);
  await expect(frame.getByText("Next week event")).toHaveCount(0);
  expect(layout.sundayText).toContain("Sunday event");
  expect(layout.sunday.y - layout.columns[6]!.y).toBeCloseTo(23, 0);
  expect(layout.dayColumns).toHaveLength(1);
  expect(layout.dayColumns[0]!.width).toBeCloseTo(layout.dayGrid.width - 1, 0);
  expect(layout.dayEvent.y - layout.dayColumns[0]!.y).toBeCloseTo(67, 0);
  expect(layout.dayText).toContain("Day event");
  expect(layout.dayText).toContain("9:30");
  await captureScreenshot(page, testInfo, "page-calendar-two-columns");
});

test("shared page contents jump below the header and copy fallback", async ({
  page,
  browser,
}, testInfo) => {
  await signup(page, `pages-anchor-${Date.now()}@rakazo.test`, "password12", "Page Reader");
  await completeOnboarding(page);
  const title = "Reading guide";
  const source = `export default function Guide() {
    return <Page title="Reading guide">
      <TableOfContents items={[{ label: "Details", id: "details" }]} />
      <Section heading="Introduction">{Array.from({ length: 30 }, (_, i) => <Text key={i}>An example paragraph before the destination.</Text>)}</Section>
      <Section heading="Details" id="details">{Array.from({ length: 30 }, (_, i) => <Text key={i}>An example paragraph after the destination.</Text>)}</Section>
    </Page>;
  }`;
  await send(page, `call save_page with ${JSON.stringify({ title, source })}\nthen say Done.`);
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole("button", { name: `Open ${title}` }).click();
  await page.getByTestId("page-view").getByRole("button", { name: "Share" }).click();
  const share = page.getByTestId("page-share");
  await share.getByRole("radio", { name: /Anyone with the link/ }).click();
  const link = share.getByRole("link", { name: "Open link" });
  await expect(link).toBeVisible();
  const visitor = await browser.newContext({ reducedMotion: "reduce" });
  const outside = await visitor.newPage();
  await outside.setViewportSize({ width: 1280, height: 720 });
  await outside.goto((await link.getAttribute("href"))!);
  const frame = pageFrame(outside, title);
  const target = frame.getByRole("heading", { name: "Details", exact: true });
  const jump = async () => {
    await frame.getByRole("link", { name: "Details", exact: true }).click();
    const header = (await outside.locator("header").boundingBox())!;
    // Nested-frame scrolling rounds fractional CSS coordinates. Allow one pixel, not an
    // obscured heading (the original layout placed it at the top of the viewport).
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? -Infinity)
      .toBeGreaterThanOrEqual(header.y + header.height - 1);
    await expect.poll(async () => (await target.boundingBox())?.y ?? Infinity).toBeLessThan(300);
    expect(await outside.evaluate(() => window.scrollY)).toBe(0);
  };
  await jump();
  await captureScreenshot(outside, testInfo, "page-public-contents-jump");
  // A failed clipboard write leaves the manual-copy prompt outside the page's scroll area.
  await outside.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
    document.execCommand = () => false;
  });
  await outside.getByRole("button", { name: "Copy link" }).click();
  const fallback = outside.getByRole("textbox", { name: "Page link" });
  await expect(fallback).toBeVisible();
  await jump();
  const fallbackBox = (await fallback.boundingBox())!;
  expect((await target.boundingBox())!.y).toBeGreaterThanOrEqual(
    fallbackBox.y + fallbackBox.height - 1,
  );
  await captureScreenshot(outside, testInfo, "page-public-contents-copy-fallback");
  await outside.setViewportSize({ width: 320, height: 120 });
  await target.scrollIntoViewIfNeeded();
  await expect(target).toBeInViewport();
  await captureScreenshot(outside, testInfo, "page-public-short-viewport");
  await outside.setViewportSize({ width: 1280, height: 720 });
  await outside.emulateMedia({ media: "print" });
  await expect(outside.locator("header")).toBeHidden();
  await expect(fallback).toBeHidden();
  expect(
    await outside.locator("[data-page-print]").evaluate((shell) => shell.scrollHeight),
  ).toBeGreaterThan(720);
  await visitor.close();
});

test("a bot's page shows in its reply, opens full screen, is shared by link and updates", async ({
  page,
  browser,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-${Date.now()}@rakazo.test`, "password12", "Page Owner");
  await completeOnboarding(page);

  const title = "Test dashboard (example data)";
  await send(
    page,
    `call save_page with ${JSON.stringify({ title, source: dashboard("2.1%") })}\nthen say I made a ${title} with made-up example data.`,
  );
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  await expect(card).toContainText(title);
  await expect(card).toContainText("Page");
  // The card sits under the reply that introduces it.
  await expect(page.getByTestId("message-bot-bubble").last()).toContainText(`I made a ${title}`);
  await expect(pageFrame(page, title).getByText("$12,400")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-chat-card");

  await card.getByRole("button", { name: `Open ${title}` }).click();
  const view = page.getByTestId("page-view");
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(/[?&]page=/);
  const pageId = new URL(page.url()).searchParams.get("page")!;
  await expect(
    pageFrame(page, title).getByRole("heading", { name: "Test dashboard", level: 1 }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-full-screen");
  // Opening lands on Close, and Tab reaches the title, Download PDF and Share before anything in
  // the page.
  await expect(view.getByRole("button", { name: "Close page" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: title })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: "Download PDF" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(view.getByRole("button", { name: "Share" })).toBeFocused();

  // Download PDF opens the print dialog, and on paper only the page shows: no controls, no
  // composer, no chat behind it, and the page at its full height drawn light on a dark app.
  await page.evaluate(() => {
    const counted = window as Window & { printed?: number };
    counted.printed = 0;
    window.print = () => {
      counted.printed = (counted.printed ?? 0) + 1;
    };
  });
  await view.getByRole("button", { name: "Download PDF" }).click();
  expect(await page.evaluate(() => (window as Window & { printed?: number }).printed)).toBe(1);
  await page.emulateMedia({ media: "print" });
  for (const name of ["Close page", title, "Download PDF", "Share"]) {
    await expect(view.getByRole("button", { name })).toBeHidden();
  }
  await expect(page.getByRole("combobox", { name: /^Message/ })).toBeHidden();
  await expect(card).toBeHidden();
  const printedHeading = pageFrame(page, title).getByRole("heading", {
    name: "Test dashboard",
    level: 1,
  });
  await expect(printedHeading).toBeVisible();
  await expect
    .poll(() => printedHeading.evaluate((heading) => getComputedStyle(heading).color))
    .toMatch(/^rgb\((\d|[1-9]\d), (\d|[1-9]\d), (\d|[1-9]\d)\)$/);
  const pageHeight = await pageFrame(page, title)
    .locator("body")
    .evaluate((body) => body.scrollHeight);
  await expect
    .poll(async () => (await page.locator(`iframe[title="${title}"]`).last().boundingBox())?.height)
    .toBeGreaterThanOrEqual(pageHeight);
  await captureScreenshot(page, testInfo, "page-print");
  await page.emulateMedia({ media: null });

  // A reply button on the page fills the chat's composer; the user still sends it.
  const userBubbles = page.getByTestId("message-user-bubble");
  const sentBefore = await userBubbles.count();
  await pageFrame(page, title).getByRole("button", { name: "Ask about churn" }).click();
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toHaveValue("Why did churn change this week?");
  await expect(userBubbles).toHaveCount(sentBefore);
  await composer.fill("");

  // Copying works where the page's own frame has no clipboard (Safari, phone WebViews): the
  // app copies for it and the button says so.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await pageFrame(page, title)
    .locator("body")
    .evaluate(() => {
      Object.defineProperty(navigator, "clipboard", { value: undefined });
    });
  await pageFrame(page, title).getByRole("button", { name: "Copy MRR" }).click();
  await expect(pageFrame(page, title).getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("MRR $12,400");
  // The switch itself takes the click, not only its label.
  await pageFrame(page, title).getByRole("switch").click();
  await expect(pageFrame(page, title).getByRole("switch", { name: "Targets shown" })).toBeChecked();

  // Links in the page ask first, as links in chat do, then open in a new tab through the app.
  await pageFrame(page, title).getByRole("link", { name: "https://example.com/metrics" }).click();
  const leave = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(leave).toContainText("example.com/metrics");
  const [popup] = await Promise.all([
    page.context().waitForEvent("page"),
    leave.getByRole("button", { name: "Open", exact: true }).click(),
  ]);
  expect(popup.url()).toBe("https://example.com/metrics");
  await popup.close();

  await view.getByRole("button", { name: title }).click();
  await view.getByRole("textbox", { name: "Page title" }).fill("Signups dashboard");
  await view.getByRole("textbox", { name: "Page title" }).press("Enter");
  await expect(view.getByRole("button", { name: "Signups dashboard" })).toBeVisible();

  await view.getByRole("button", { name: "Share" }).click();
  const share = page.getByTestId("page-share");
  await expect(share.getByText("Share “Signups dashboard”")).toBeVisible();
  await expect(share.getByText("Owner", { exact: true })).toBeVisible();
  await share.getByRole("radio", { name: /Anyone with the link/ }).click();
  const openLink = share.getByRole("link", { name: "Open link" });
  await expect(openLink).toBeVisible();
  // The Share button says the page is public.
  await expect(
    view.getByRole("button", { name: "Share, anyone with the link can view" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-share-anyone");
  const shareUrl = (await openLink.getAttribute("href"))!;
  expect(new URL(shareUrl).pathname).toMatch(/^\/p\/signups-dashboard-[A-Za-z0-9_-]{43}$/);
  // Copy link works without the Clipboard API, as on a server reached over plain http.
  await page.evaluate(() => {
    const scope = window as unknown as { realClipboard?: Clipboard };
    scope.realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
  });
  await share.getByRole("button", { name: "Copy link" }).click();
  await expect(share.getByRole("button", { name: "Copied" })).toBeVisible();
  await expect(share.getByRole("status")).toHaveText("Link copied");
  await captureScreenshot(page, testInfo, "page-share-copied");
  const restore = () =>
    page.evaluate(() => {
      const scope = window as unknown as { realClipboard?: Clipboard };
      Object.defineProperty(navigator, "clipboard", {
        value: scope.realClipboard,
        configurable: true,
      });
    });
  await restore();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shareUrl);
  // The label goes back to Copy link after a moment.
  await expect(share.getByRole("button", { name: "Copy link" })).toBeVisible();
  // Where the browser will not copy at all, the link is offered selected to copy by hand.
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    Object.defineProperty(document, "execCommand", { value: () => false, configurable: true });
  });
  await share.getByRole("button", { name: "Copy link" }).click();
  await expect(share.getByText("Couldn't copy. Select the link and copy it.")).toBeVisible();
  await expect(share.getByRole("textbox", { name: "Page link" })).toHaveValue(shareUrl);
  await expect(share.getByRole("textbox", { name: "Page link" })).toBeFocused();
  await captureScreenshot(page, testInfo, "page-share-copy-fallback");
  await restore();
  await page.evaluate(() => Reflect.deleteProperty(document, "execCommand"));
  // Escape closes the share popover and leaves the page open.
  await page.keyboard.press("Escape");
  await expect(share).toBeHidden();
  await expect(view).toBeVisible();

  // Signed out, the link opens the page and nothing else.
  const visitor = await browser.newContext({ colorScheme: "dark" });
  const outside = await visitor.newPage();
  // The link is the page's only key: no search engine indexes it and no Referer carries it on.
  const served = await outside.goto(shareUrl);
  expect(served?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  expect(served?.headers()["referrer-policy"]).toBe("no-referrer");
  await expect(outside.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    "noindex, nofollow",
  );
  await expect(outside.getByRole("heading", { name: "Signups dashboard", level: 1 })).toBeVisible();
  await expect(outside.getByRole("button", { name: "Download PDF" })).toBeVisible();
  await expect(outside.getByRole("link", { name: "Open Rakazo" })).toBeVisible();
  await expect(pageFrame(outside, "Signups dashboard").getByText("$12,400")).toBeVisible();
  // There is no chat beside a shared page, so its reply buttons do nothing.
  await expect(
    pageFrame(outside, "Signups dashboard").getByRole("button", { name: "Ask about churn" }),
  ).toBeDisabled();
  await captureScreenshot(outside, testInfo, "page-public");
  await visitor.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pageFrame(outside, "Signups dashboard").getByRole("button", { name: "Copy MRR" }).click();
  await expect(
    pageFrame(outside, "Signups dashboard").getByRole("button", { name: "Copied" }),
  ).toBeVisible();
  expect(await outside.evaluate(() => navigator.clipboard.readText())).toBe("MRR $12,400");
  // The viewer's own Copy link works over plain http too.
  await outside.evaluate(() => {
    const scope = window as unknown as { realClipboard?: Clipboard };
    scope.realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
  });
  await outside.getByRole("button", { name: "Copy link" }).click();
  await expect(outside.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(
    await outside.evaluate(() =>
      (window as unknown as { realClipboard: Clipboard }).realClipboard.readText(),
    ),
  ).toBe(shareUrl);
  // The page's code failing to download is not a blank page: the visitor can try again.
  await outside.route("**/api/v1/assets/page-runtime.js", (route) =>
    route.fulfill({ status: 503 }),
  );
  await outside.reload();
  await expect(outside.getByRole("alert")).toHaveText("Couldn't load this page. Try again.");
  await outside.unroute("**/api/v1/assets/page-runtime.js");
  await outside.getByRole("button", { name: "Try again" }).click();
  await expect(pageFrame(outside, "Signups dashboard").getByText("$12,400")).toBeVisible();

  // The docked composer talks to the same chat, naming the page.
  await send(page, "make the churn tile red");
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();
  await expect(page).not.toHaveURL(/[?&]page=/);
  await expect(card).toContainText(/Page · Shared · \S/);
  await captureScreenshot(page, testInfo, "page-card-shared");
  await expect(
    page.getByTestId("message-user-bubble").filter({ hasText: "make the churn tile red" }),
  ).toBeVisible();
  // It replies to the page's card, so the bot reads which page it is about by id.
  const history = await rpc<{
    messages: Array<{ id: string; replyToMessageId?: string; blocks: Array<{ kind: string }> }>;
  }>(page, "threads/messages", { botId: activeBotId(page) });
  const asked = history.messages.find((message) =>
    message.blocks.some(
      (block) =>
        block.kind === "text" && "text" in block && block.text === "make the churn tile red",
    ),
  );
  const target = history.messages.find((message) => message.id === asked?.replyToMessageId);
  expect(target?.blocks).toContainEqual({ kind: "page", pageId, version: 1, title });

  await send(
    page,
    `call save_page with ${JSON.stringify({ pageId, title: "Signups dashboard", source: dashboard("1.9%") })}\nthen say Updated [Signups dashboard](page:${pageId}) with the new churn figure.`,
  );
  // Anyone with the link would see the change at once, so the bot asks first. The sidebar's
  // unread preview can show the same words, so look for the card in the transcript.
  await expect(
    page.getByTestId("transcript").getByText("Update shared page “Signups dashboard”?"),
  ).toBeVisible({
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "page-shared-update-approval");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(card).toHaveCount(2, { timeout: 30_000 });
  await expect(card.first()).toContainText("Updated below");
  await expect(card.last()).not.toContainText("Updated below");
  // Previews draw once their card scrolls near view.
  await card.last().scrollIntoViewIfNeeded();
  await expect(pageFrame(page, "Signups dashboard").getByText("1.9%")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-updated-below");

  // The reply names the page as a chip that opens it.
  const chip = page.getByTestId("message-bot-bubble").last().getByRole("button", {
    name: "Signups dashboard",
  });
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(view).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`[?&]page=${pageId}`));
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();

  // The older card opens the latest version.
  await card.first().getByRole("button", { name: "Open Signups dashboard" }).click();
  await expect(view).toBeVisible();
  await expect(pageFrame(page, "Signups dashboard").getByText("1.9%")).toBeVisible();
  await page.keyboard.press("Escape");

  await openBotPanelTab(page, "Pages");
  await page
    .getByTestId("bot-pages")
    .getByRole("button", { name: /^Signups dashboard/ })
    .click();
  await expect(view).toBeVisible();

  // Turning the link off breaks it at once.
  await view.getByRole("button", { name: "Share" }).click();
  await expect(share.getByText("The shared link stops working")).toBeVisible();
  await share.getByRole("radio", { name: /Only you/ }).click();
  await expect(share.getByRole("link", { name: "Open link" })).toBeHidden();
  await outside.reload();
  await expect(outside.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  await expect(outside.getByRole("link", { name: "Open Rakazo" })).toBeVisible();
  await captureScreenshot(outside, testInfo, "page-public-unavailable");
  // Busy or unreachable is not gone: the visitor is asked to try again.
  await outside.route("**/api/v1/pages/shared/**", (route) => route.fulfill({ status: 503 }));
  await outside.reload();
  await expect(outside.getByRole("alert")).toHaveText("Couldn't load this page. Try again.");
  await captureScreenshot(outside, testInfo, "page-public-error");
  await outside.unroute("**/api/v1/pages/shared/**");
  await outside.getByRole("button", { name: "Try again" }).click();
  await expect(outside.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  await visitor.close();
  await page.keyboard.press("Escape");
  await expect(share).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(view).toBeHidden();

  // The Library pins a page into its own group and deletes it after naming it.
  const library = page.getByTestId("bot-pages");
  const more = library.getByRole("button", { name: "Actions for Signups dashboard" });
  await more.click();
  await captureScreenshot(page, testInfo, "page-library-menu");
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(library.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-library-pinned");
  await more.click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Signups dashboard?" });
  await captureScreenshot(page, testInfo, "page-delete-confirm");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Pages this bot builds for you appear here.")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-library-empty");

  // The header pill reopens the bot panel on the Pages tab it closed on.
  const pill = page.getByTestId("bot-settings-trigger");
  await pill.click();
  await expect(pill).toHaveAttribute("aria-expanded", "false");
  await pill.click();
  await expect(
    page.getByTestId("bot-settings").getByRole("tab", { name: "Pages", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

function tiny(heading: string) {
  return `function Tiny() {
  return <Page title="${heading}"><Text>${heading} body</Text></Page>;
}
export default Tiny;`;
}

/** The server makes the change, then the connection drops before its answer arrives. */
async function loseAnswer(route: Route) {
  await route.fetch();
  await route.abort("failed");
}

/** Closes the open page, and first its Share popover if that is showing. */
async function closePage(page: Page) {
  const share = page.getByTestId("page-share");
  if (await share.isVisible()) {
    await page.keyboard.press("Escape");
    await expect(share).toBeHidden();
  }
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("page-view")).toBeHidden();
}

test("in the macOS app a page's top row sits below the window controls and its close button clicks", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-mac-${Date.now()}@rakazo.test`, "password12", "Page Owner");
  await completeOnboarding(page);
  const title = "Test dashboard (example data)";
  await send(
    page,
    `call save_page with ${JSON.stringify({ title, source: dashboard("2.1%") })}\nthen say done.`,
  );
  await expect(page.getByTestId("page-card")).toHaveCount(1, { timeout: 30_000 });
  // The desktop app's bridge on macOS, whose traffic lights sit 16px in from the top left.
  await page.addInitScript(() => {
    (window as unknown as { rakazoDesktop: { platform: string } }).rakazoDesktop = {
      platform: "darwin",
    };
  });
  await page.reload();
  await page
    .getByTestId("page-card")
    .getByRole("button", { name: `Open ${title}` })
    .click();
  const view = page.getByTestId("page-view");
  await expect(
    pageFrame(page, title).getByRole("heading", { name: "Test dashboard", level: 1 }),
  ).toBeVisible();
  const close = view.getByRole("button", { name: "Close page" });
  // Below the 12px traffic lights at y 16, and outside the window's drag areas, which Electron
  // applies through anything drawn over them. macOS draws the lights from x=16 to about x=68.
  const box = await close.boundingBox();
  expect(box!.y).toBeGreaterThanOrEqual(36);
  // Close page must clear the 72px traffic-light strip (#3450).
  expect(box!.x).toBeGreaterThanOrEqual(72);
  for (const control of [
    close,
    view.getByRole("button", { name: title }),
    view.getByRole("button", { name: "Share" }),
  ]) {
    expect(
      await control.evaluate((el) => getComputedStyle(el).getPropertyValue("app-region")),
    ).not.toBe("drag");
  }
  await captureScreenshot(page, testInfo, "page-full-screen-macos");
  await close.click();
  await expect(view).toBeHidden();

  // #3757: on a narrow window the nav hamburger must clear the same traffic-light strip.
  await page.setViewportSize({ width: 500, height: 860 });
  const openNav = page.getByRole("button", { name: "Open navigation" });
  await expect(openNav).toBeVisible();
  const navBox = await openNav.boundingBox();
  expect(navBox!.x).toBeGreaterThanOrEqual(72);
  await captureScreenshot(page, testInfo, "open-navigation-macos");
});

test("a page's failures, a deleted page's card, and the Library's Share, search and rename", async ({
  page,
}, testInfo) => {
  // Nine saves through the bot: more than the default budget on a busy machine.
  test.setTimeout(240_000);
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-states-${Date.now()}@rakazo.test`, "password12", "Page States");
  await completeOnboarding(page);
  // The command palette caches its own page list; new cards must not trip over it.
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  const cards = page.getByTestId("page-card");
  const save = async (title: string) => {
    await send(
      page,
      `call save_page with ${JSON.stringify({ title, source: tiny(title) })}\nthen say Made ${title}.`,
    );
    await expect(cards.filter({ hasText: title })).toHaveCount(1, { timeout: 30_000 });
  };
  await save("Alpha");
  await save("Beta");
  const view = page.getByTestId("page-view");
  const share = page.getByTestId("page-share");
  const open = async (title: string) => {
    await cards
      .filter({ hasText: title })
      .getByRole("button", { name: `Open ${title}` })
      .click();
    await expect(view).toBeVisible();
  };

  // The composer is one element that moves onto the page and back, so nothing in it is lost.
  const bar = await page.getByTestId("composer-bar").elementHandle();
  const onPage = () =>
    bar!.evaluate((element) =>
      element.isConnected ? Boolean(element.closest('[data-testid="page-view"]')) : null,
    );
  expect(await onPage()).toBe(false);
  // Sent from the open page, the message replies to the page's card but quotes nothing.
  await open("Alpha");
  expect(await onPage()).toBe(true);
  await send(page, "make it bigger");
  await closePage(page);
  // Focus goes back to the clicked card without a keyboard ring.
  const alphaOpen = cards.filter({ hasText: "Alpha" }).getByRole("button", { name: "Open Alpha" });
  await expect(alphaOpen).toBeFocused();
  expect(await alphaOpen.evaluate((button) => button.matches(":focus-visible"))).toBe(false);
  const asked = page.getByTestId("message-user-bubble").filter({ hasText: "make it bigger" });
  await asked.scrollIntoViewIfNeeded();
  await expect(asked).toBeVisible();
  await expect(page.getByTestId("reply-parent-preview")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "page-reply-no-quote");

  // A share the server made but whose answer was lost shows what the server has: the link on.
  await page.route("**/rpc/pages/setVisibility", loseAnswer);
  await open("Alpha");
  await view.getByRole("button", { name: "Share" }).click();
  const onlyYou = share.getByRole("radio", { name: /Only you/ });
  const anyone = share.getByRole("radio", { name: /Anyone with the link/ });
  await anyone.click();
  await expect(share.getByRole("alert")).toHaveText(
    "Could not change who can view this page. Try again.",
  );
  await expect(anyone).toBeChecked();
  await expect(share.getByRole("button", { name: "Copy link" })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-share-error");
  // Turned off the same way while the page can't be read: neither choice is claimed, and Only you
  // still sends, so the link can always be turned off.
  await page.route("**/rpc/pages/get", (route) => route.fulfill({ status: 500 }));
  await onlyYou.click();
  await expect(share.getByRole("alert")).toBeVisible();
  await expect(onlyYou).not.toBeChecked();
  await expect(anyone).not.toBeChecked();
  await expect(share.getByRole("button", { name: "Copy link" })).toBeHidden();
  await page.unroute("**/rpc/pages/setVisibility");
  await page.unroute("**/rpc/pages/get");
  const revoke = page.waitForRequest(
    (request) =>
      request.url().includes("/rpc/pages/setVisibility") &&
      (request.postData() ?? "").includes('"private"'),
  );
  await onlyYou.click();
  await revoke;
  await expect(onlyYou).toBeChecked();
  await expect(share.getByRole("alert")).toHaveCount(0);
  await closePage(page);
  await open("Beta");
  await expect(view.getByRole("alert")).toHaveCount(0);
  await view.getByRole("button", { name: "Share" }).click();
  await expect(share.getByRole("alert")).toHaveCount(0);
  await expect(share.getByRole("radio", { name: /Only you/ })).toBeEnabled();

  // A failed rename says so under the title.
  await page.keyboard.press("Escape");
  await expect(share).toBeHidden();
  await page.route("**/rpc/pages/rename", (route) => route.abort("failed"));
  await view.getByRole("button", { name: "Beta" }).click();
  await view.getByRole("textbox", { name: "Page title" }).fill("Gamma");
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Enter", "Escape"]) {
      await view.getByRole("textbox", { name: "Page title" }).dispatchEvent("keydown", {
        key,
        bubbles: true,
        ...composition,
      });
      await expect(view.getByRole("textbox", { name: "Page title" })).toHaveValue("Gamma");
    }
  }
  await view.getByRole("textbox", { name: "Page title" }).press("Enter");
  await expect(view.getByRole("alert")).toHaveText("Could not rename this page. Try again.");
  await captureScreenshot(page, testInfo, "page-rename-error");
  await page.unroute("**/rpc/pages/rename");
  await closePage(page);
  expect(await onPage()).toBe(false);
  // Opened again, the page starts clean.
  await open("Beta");
  await expect(view.getByRole("alert")).toHaveCount(0);
  // Leaving by Back with Share open, then Forward, shows the page without it.
  await view.getByRole("button", { name: "Share" }).click();
  await expect(share).toBeVisible();
  await page.goBack();
  await expect(view).toBeHidden();
  await page.goForward();
  await expect(view).toBeVisible();
  await expect(share).toBeHidden();
  await closePage(page);

  // A page that cannot be read says so with a way to try again, not a blank or closed view.
  await page.route("**/rpc/pages/get", (route) => route.fulfill({ status: 500 }));
  await page.reload();
  // Its card stops looking like it is still loading.
  const betaCard = cards.filter({ hasText: "Beta" }).first();
  const stillLoading = betaCard.locator(".motion-safe\\:animate-pulse");
  await expect(betaCard).toBeVisible();
  await expect(stillLoading).toHaveCount(0, { timeout: 15_000 });
  await open("Beta");
  const betaId = new URL(page.url()).searchParams.get("page")!;
  await expect(view.getByRole("heading", { name: "This page couldn't load" })).toBeVisible({
    timeout: 15_000,
  });
  await captureScreenshot(page, testInfo, "page-view-load-error");
  await page.unroute("**/rpc/pages/get");
  await view.getByRole("button", { name: "Try again" }).click();
  await expect(view.getByRole("heading", { name: "This page couldn't load" })).toBeHidden();
  await expect(view.getByRole("button", { name: "Beta" })).toBeVisible();
  await closePage(page);
  // So does a page whose code failed to download, and Try again downloads it again.
  await page.route("**/api/v1/assets/page-runtime.js", (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await expect(betaCard).toBeVisible();
  await expect(stillLoading).toHaveCount(0, { timeout: 15_000 });
  await open("Beta");
  await expect(view.getByRole("heading", { name: "This page couldn't load" })).toBeVisible({
    timeout: 15_000,
  });
  await page.unroute("**/api/v1/assets/page-runtime.js");
  await view.getByRole("button", { name: "Try again" }).click();
  await expect(
    view
      .locator('iframe[title="Beta"]')
      .contentFrame()
      .locator("iframe#preview")
      .contentFrame()
      .getByText("Beta body"),
  ).toBeVisible();
  await closePage(page);

  // A page that fails to draw says so instead of showing a blank sheet.
  await page.route("**/rpc/pages/get", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json?: { title?: string; code?: string } };
    if (body.json?.title === "Beta") {
      body.json.code = "exports.default = function Broken() { throw new Error('boom'); };";
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await open("Beta");
  await expect(
    view
      .locator('iframe[title="Beta"]')
      .contentFrame()
      .locator("iframe#preview")
      .contentFrame()
      .getByText("This page couldn't be shown."),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-render-error");
  await page.unroute("**/rpc/pages/get");
  await closePage(page);

  // The Library's Share opens the popover, every time.
  await openBotPanelTab(page, "Pages");
  const library = page.getByTestId("bot-pages");
  for (let round = 0; round < 2; round++) {
    await library.getByRole("button", { name: "Actions for Alpha" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
    await expect(share.getByText("Share “Alpha”")).toBeVisible();
    await closePage(page);
  }
  // Back to the page in history opens it, not its Share popover again.
  await page.goBack();
  await expect(view).toBeVisible();
  await expect(share).toBeHidden();
  await page.goForward();
  await expect(view).toBeHidden();

  // A failed delete keeps the confirmation open with the reason.
  await page.route("**/rpc/pages/remove", (route) => route.abort("failed"));
  await library.getByRole("button", { name: "Actions for Beta" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const confirm = page.getByRole("alertdialog", { name: "Delete Beta?" });
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm.locator("p.text-destructive")).not.toBeEmpty();
  await captureScreenshot(page, testInfo, "page-delete-error");
  await page.unroute("**/rpc/pages/remove");
  await confirm.getByRole("button", { name: "Delete" }).click();
  await expect(confirm).toBeHidden();

  // The deleted page's card stays in the chat, calm and closed.
  const deleted = cards.filter({ hasText: "Beta" });
  await expect(deleted).toContainText("Page · Deleted");
  await expect(deleted.getByRole("button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "page-card-deleted");

  // A link to the deleted page opens to a clear message, not a silent close.
  await page.goto(`${page.url().split("?")[0]}?page=${betaId}`);
  await expect(view.getByRole("heading", { name: "This page isn't available" })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-view-deleted");
  await view.getByRole("button", { name: "Back to chat" }).click();
  await expect(view).toBeHidden();

  // A longer list gets a field to find a page by title.
  for (const title of ["One", "Two", "Three", "Four", "Five", "Six", "Seven"]) await save(title);
  await openBotPanelTab(page, "Pages");
  await expect(library.getByRole("listitem")).toHaveCount(8);
  await expect(library.getByRole("button", { name: "Show more" })).toBeHidden();
  await library.getByRole("searchbox", { name: "Find a page" }).fill("sev");
  await expect(library.getByRole("listitem")).toHaveCount(1);
  await library.getByRole("searchbox", { name: "Find a page" }).fill("nothing like it");
  await expect(library.getByText("No pages match “nothing like it”.")).toBeVisible();
  await library.getByRole("searchbox", { name: "Find a page" }).fill("");

  // Rename is in each page's menu, on every screen size.
  await library.getByRole("button", { name: "Actions for Alpha" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await library.getByRole("textbox", { name: "Page title" }).fill("Alpha renamed");
  for (const composition of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ["Enter", "Escape"]) {
      await library.getByRole("textbox", { name: "Page title" }).dispatchEvent("keydown", {
        key,
        bubbles: true,
        ...composition,
      });
      await expect(library.getByRole("textbox", { name: "Page title" })).toHaveValue(
        "Alpha renamed",
      );
    }
  }
  await captureScreenshot(page, testInfo, "page-library-rename");
  await library.getByRole("textbox", { name: "Page title" }).press("Enter");
  await expect(library.getByRole("button", { name: /^Alpha renamed/ })).toBeVisible();

  // A pin the server made but whose answer was lost: the list shows it pinned, and says it failed.
  await page.route("**/rpc/pages/pin", loseAnswer);
  await library.getByRole("button", { name: "Actions for Alpha renamed" }).click();
  await page.getByRole("menuitem", { name: "Pin" }).click();
  await expect(library.getByRole("alert")).toHaveText("Could not pin this page. Try again.");
  await expect(library.getByRole("heading", { name: "Pinned" })).toBeVisible();
  await captureScreenshot(page, testInfo, "page-library-pin-error");
  await page.unroute("**/rpc/pages/pin");

  // A list that can't be read again keeps the pages it has and says so.
  await page.route("**/rpc/pages/list", (route) => route.fulfill({ status: 500 }));
  await library.getByRole("button", { name: "Actions for Alpha renamed" }).click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await library.getByRole("textbox", { name: "Page title" }).fill("Alpha");
  await library.getByRole("textbox", { name: "Page title" }).press("Enter");
  const listError = library.getByRole("alert");
  await expect(listError).toContainText("Couldn't load pages.");
  await expect(library.getByRole("listitem")).toHaveCount(8);
  await captureScreenshot(page, testInfo, "page-library-stale-error");
  // A list that can't be read at all is not shown as empty.
  await page.reload();
  await openBotPanelTab(page, "Pages");
  const unread = page.getByTestId("bot-settings").getByRole("alert");
  await expect(unread).toContainText("Couldn't load pages.");
  await expect(page.getByText("Pages this bot builds for you appear here.")).toBeHidden();
  await captureScreenshot(page, testInfo, "page-library-error");
  await page.unroute("**/rpc/pages/list");
  await unread.getByRole("button", { name: "Try again" }).click();
  await expect(library.getByRole("listitem")).toHaveCount(8);
  await expect(unread).toBeHidden();
});

test("a group's pages show in its settings, and the palette finds and opens a page", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => localStorage.setItem("rakazo.uiAppearance", "dark"));
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-group-${Date.now()}@rakazo.test`, "password12", "Group Pages");
  await completeOnboarding(page);
  const planner = await createNamedBot(page, "Planner");
  const writer = await createNamedBot(page, "Writer");
  const group = await rpc<{ id: string }>(page, "groups/create", {
    name: "Launch team",
    botIds: [planner, writer],
  });
  await page.goto(`/app/g/${group.id}`);
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("side-panel");
  await expect(settings).toHaveAttribute("data-panel", "group-settings");
  await expect(settings.getByRole("heading", { name: "Pages" })).toBeVisible();
  await expect(
    settings.getByText(
      "Pages this group builds for you appear here. Ask for a dashboard, tracker or plan to make one.",
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "page-group-settings-empty");
  await page.getByTestId("bot-settings-trigger").click();
  await expect(settings).toBeHidden();

  await send(
    page,
    `@Planner call save_page with ${JSON.stringify({ title: "Launch checklist", source: tiny("Launch checklist") })}\nthen say Made the Launch checklist.`,
  );
  await expect(page.getByTestId("page-card")).toHaveCount(1, { timeout: 30_000 });
  await page.getByTestId("bot-settings-trigger").click();
  await expect(settings.getByText("Launch checklist")).toBeVisible();
  await captureScreenshot(page, testInfo, "page-group-settings");
  await page.getByTestId("bot-settings-trigger").click();

  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("command-palette");
  await expect(palette).toBeVisible();
  await page.keyboard.type("launch che");
  await expect(palette.getByText("Pages", { exact: true })).toBeVisible();
  const row = palette.getByRole("option", { name: /Launch checklist/ });
  await expect(row).toBeVisible();
  await captureScreenshot(page, testInfo, "page-palette");
  await row.click();
  await expect(palette).toBeHidden();
  await expect(page.getByTestId("page-view")).toBeVisible();
  await expect(
    pageFrame(page, "Launch checklist").getByRole("heading", { name: "Launch checklist" }),
  ).toBeVisible();
});

/** A page that asks the app to copy, open a link and fill a reply as soon as it loads. */
const ROGUE = `Object.defineProperty(KeyboardEvent.prototype, "repeat", { get: () => false });
function Rogue() {
  const [sent, setSent] = useState(0);
  useEffect(() => {
    let keys = 0;
    const onKey = () => {
      keys += 1;
      parent.postMessage({ type: "rakazo-page:copy", id: "key" + keys, text: "key " + keys }, "*");
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    const ask = () => {
      parent.postMessage({ type: "rakazo-page:copy", id: "load", text: "copied on load" }, "*");
      parent.postMessage({ type: "rakazo-page:open-link", url: "https://example.com/on-load" }, "*");
      parent.postMessage({ type: "rakazo-page:reply", text: "replied on load" }, "*");
      setSent((count) => count + 1);
    };
    ask();
    const timer = setInterval(ask, 300);
    setTimeout(() => clearInterval(timer), 1500);
    return () => clearInterval(timer);
  }, []);
  return (
    <Page title="Rogue">
      <Text>{sent >= 5 ? "Sent on load" : "Sending"}</Text>
      <CopyButton label="Copy now" text="copied after a click" />
      <button
        onClick={() => {
          parent.postMessage({ type: "rakazo-page:copy", id: "one", text: "first copy" }, "*");
          parent.postMessage({ type: "rakazo-page:copy", id: "two", text: "second copy" }, "*");
          parent.postMessage({ type: "rakazo-page:reply", text: "replied too" }, "*");
        }}
      >
        Ask three times
      </button>
      <Text>Read more: https://example.com/after-click</Text>
    </Page>
  );
}
export default Rogue;`;

test("a page acts for its reader only after a click in it, never on load or from a card", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await signup(page, `pages-rogue-${Date.now()}@rakazo.test`, "password12", "Rogue Reader");
  await completeOnboarding(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("untouched"));
  const opened: string[] = [];
  page.context().on("page", (tab) => opened.push(tab.url()));
  const composer = page.getByRole("combobox", { name: /^Message/ });
  const untouched = async () => {
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("untouched");
    expect(opened).toEqual([]);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect(composer).toHaveValue("");
  };

  await send(
    page,
    `call save_page with ${JSON.stringify({ title: "Rogue", source: ROGUE })}\nthen say Done.`,
  );
  const card = page.getByTestId("page-card");
  await expect(card).toHaveCount(1, { timeout: 30_000 });
  // The card's live preview runs the page, which asks five times on load.
  await expect(pageFrame(page, "Rogue").getByText("Sent on load")).toBeVisible();
  await untouched();

  // Opening it full screen is a click in the app, not in the page.
  await card.getByRole("button", { name: "Open Rogue" }).click();
  await expect(page.getByTestId("page-view")).toBeVisible();
  await expect(pageFrame(page, "Rogue").getByText("Sent on load")).toBeVisible();
  await untouched();

  // A click inside the page lets the app copy for it, and its link still asks before leaving.
  await pageFrame(page, "Rogue").getByRole("button", { name: "Copy now" }).click();
  await expect(pageFrame(page, "Rogue").getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("copied after a click");
  await pageFrame(page, "Rogue")
    .getByRole("link", { name: "https://example.com/after-click" })
    .click();
  const leave = page.getByRole("alertdialog", { name: "Open external link?" });
  await expect(leave).toContainText("example.com/after-click");
  await captureScreenshot(page, testInfo, "page-link-confirm");
  await leave.getByRole("button", { name: "Cancel" }).click();
  await expect(leave).toBeHidden();
  expect(opened).toEqual([]);

  // One click is one action: what else the page asks for with that click is dropped.
  await pageFrame(page, "Rogue").getByRole("button", { name: "Ask three times" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("first copy");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("first copy");
  await expect(composer).toHaveValue("");

  // A held key is one gesture, even when the page hides that its keydowns repeat.
  await page.waitForTimeout(1100);
  await page.keyboard.down("a");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("key 1");
  await page.keyboard.down("a");
  await page.keyboard.down("a");
  await page.keyboard.up("a");
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("key 1");
});
