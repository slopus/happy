import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("changing language updates settings overflow without resizing", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `settings-language-${stamp}@rakazo.test`, "password12", "Settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  // Below the desktop breakpoint, where the section list scrolls sideways.
  await page.setViewportSize({ width: 640, height: 700 });
  const nav = settings.getByTestId("settings-nav");
  const next = settings.getByRole("button", { name: "Nächste Einstellungsbereiche" });
  const overflow = () => nav.evaluate((node) => node.scrollWidth - node.clientWidth);
  const english = await overflow();

  const language = settings.getByTestId("ui-locale-select");
  await language.click();
  await page.getByRole("option", { name: "Deutsch", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Allgemein", exact: true })).toBeVisible();
  // Longer German labels overflow further, and the scroll control follows without a resize.
  await expect.poll(overflow).toBeGreaterThan(english);
  await expect(next).toBeVisible();
  await expect(next).toBeEnabled();
  await captureScreenshot(page, testInfo, "settings-tabs-language-overflow");

  await language.click();
  await page.getByRole("option", { name: "English", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect.poll(overflow).toBe(english);
});

test("narrow settings reveals the active section and offers scroll controls", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `settings-narrow-${stamp}@rakazo.test`, "password12", "Settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "organization");
  const nav = settings.getByTestId("settings-nav");
  // The last section, so the nav has nothing further to scroll to.
  const last = settings.getByTestId("settings-nav-organization");
  const previous = settings.getByRole("button", { name: "Previous settings sections" });
  const next = settings.getByRole("button", { name: "Next settings sections" });

  for (const width of [640, 390]) {
    await page.setViewportSize({ width, height: 700 });
    await expect(last).toHaveAttribute("aria-current", "page");
    // Deep links and resizing must reveal the whole selected section.
    await expect
      .poll(async () => {
        const viewport = await nav.boundingBox();
        const active = await last.boundingBox();
        return Boolean(
          viewport &&
            active &&
            active.x >= viewport.x - 1 &&
            active.x + active.width <= viewport.x + viewport.width + 1,
        );
      })
      .toBe(true);
    await expect(previous).toBeEnabled();
    await expect(next).toBeDisabled();
    await captureScreenshot(page, testInfo, `settings-tabs-${width}`);
    const offset = await nav.evaluate((node) => node.scrollLeft);
    await previous.click();
    await expect.poll(() => nav.evaluate((node) => node.scrollLeft)).toBeLessThan(offset);
    await settings.getByTestId("settings-nav-general").click();
    await expect(settings).toHaveAttribute("data-settings-section", "general");
    await expect(next).toBeEnabled();
    await next.click();
    await expect.poll(() => nav.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const header = settings.getByTestId("settings-header");
    const before = await header.boundingBox();
    await settings.getByTestId("delete-account").scrollIntoViewIfNeeded();
    await expect
      .poll(() => settings.getByTestId("settings-scroll").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(0);
    expect(await header.boundingBox()).toEqual(before);
    expect(await settings.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(settings.getByRole("button", { name: "Close user settings" })).toBeVisible();
    await captureScreenshot(page, testInfo, `settings-narrow-scrolled-${width}`);
    await last.click();
    await expect(settings).toHaveAttribute("data-settings-section", "organization");
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(previous).toBeHidden();
  await expect(next).toBeHidden();
  await expect(last).toBeVisible();
  await expect(last).toHaveAttribute("aria-current", "page");
});

test("settings shell is two-pane and deep-links Models Memory Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  const settings = await openUserSettings(page);
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  const streamReplies = settings.getByTestId("response-streaming-toggle");
  await expect(streamReplies).toBeVisible();
  await expect(streamReplies).not.toBeChecked();
  await streamReplies.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "settings-shell-general");
  const scroller = settings.getByTestId("settings-scroll");
  await scroller.evaluate((node) => {
    node.scrollTop = Math.max(0, (node.scrollHeight - node.clientHeight) / 2);
  });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  // Scrolled content clips at a visible divider with space under the subtitle.
  const headerEdge = await settings.getByTestId("settings-header").evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      border: Number.parseFloat(style.borderBottomWidth),
      borderStyle: style.borderBottomStyle,
      padding: Number.parseFloat(style.paddingBottom),
    };
  });
  expect(headerEdge.border).toBeGreaterThanOrEqual(1);
  expect(headerEdge.borderStyle).toBe("solid");
  expect(headerEdge.padding).toBeGreaterThanOrEqual(16);
  await captureScreenshot(page, testInfo, "settings-shell-scrolled");
  await streamReplies.click();
  await expect(streamReplies).toBeChecked();
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem("rakazo.responseStreaming")))
    .toBe("on");
  const deleteAccount = settings.getByTestId("delete-account");
  await deleteAccount.scrollIntoViewIfNeeded();
  await expect(deleteAccount).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-general-delete-account");
  await deleteAccount.click();
  await expect(settings.getByLabel("Current password", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-general-delete-confirmation");
  await deleteAccount.click();

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await expect(settings.getByTestId("model-role-main")).toBeVisible();
  await expect(settings.getByTestId("model-role-approval")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await memory.getByRole("button", { name: "Connect memory provider", exact: true }).click();
  await expect(memory.getByLabel("Provider")).toBeVisible();
  await memory.getByLabel("Provider").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");
  await memory.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity-advanced");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");
  const voice = settings.getByTestId("voice-settings");
  await voice.getByLabel("Provider", { exact: true }).selectOption("xai");
  await expect(voice.getByLabel("API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice-xai");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});

test("Honcho memory settings empty and filled", async ({ page }, testInfo) => {
  // These screenshots never submit credentials or contact Honcho.
  const stamp = Date.now();
  await signup(page, `memory-honcho-${stamp}@rakazo.test`, "password12", "Memory settings");
  await completeOnboarding(page);
  const settings = await openUserSettings(page, "memory");
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Provider")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "memory-default");
  await memory.getByRole("button", { name: "Connect memory provider", exact: true }).click();
  await memory.getByLabel("Provider").selectOption("honcho");
  await expect(memory.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(memory.getByLabel("Workspace", { exact: true })).not.toBeVisible();
  await captureScreenshot(page, testInfo, "memory-honcho-simple");
  await memory.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(memory.getByLabel("Workspace", { exact: true })).toBeVisible();
  await expect(memory.getByLabel("User peer", { exact: true })).toHaveCount(0);
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await page.setViewportSize({ width: 1280, height: 900 });
  await captureScreenshot(page, testInfo, "memory-honcho-empty");
  await memory.getByLabel("API key", { exact: true }).fill("hch-test-key");
  await memory.getByLabel("Workspace", { exact: true }).fill("team-notes");
  const userPeer = memory.getByLabel("User peer", { exact: true });
  await userPeer.fill("bot-123");
  await expect(userPeer).toHaveAttribute("aria-invalid", "true");
  await expect(
    memory.getByText("rakazo-shared and IDs starting with bot- are reserved for Rakazo."),
  ).toBeVisible();
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await captureScreenshot(page, testInfo, "memory-honcho-user-peer-reserved");
  await userPeer.fill("user-alex");
  await expect(
    memory.getByText("Recall from this peer; save to Rakazo’s own peers."),
  ).toBeVisible();
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await memory
    .getByText("Recall from this peer; save to Rakazo’s own peers.")
    .evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureScreenshot(page, testInfo, "memory-honcho-filled");
  await memory.getByRole("button", { name: "Self-hosted", exact: true }).click();
  await expect(memory.getByLabel("Base URL", { exact: true })).toHaveValue("");
  await memory
    .getByLabel("Base URL", { exact: true })
    .fill("http://honcho-api.railway.internal:8000");
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await memory.getByLabel("Base URL", { exact: true }).fill("");
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeDisabled();
  await memory
    .getByLabel("Base URL", { exact: true })
    .fill("http://honcho-api.railway.internal:8000");
  await captureScreenshot(page, testInfo, "memory-honcho-local");
  const documents = memory.getByTestId("space-memory-documents");
  await documents.scrollIntoViewIfNeeded();
  await expect(documents).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-honcho-local-bottom");

  const scrollToTop = () =>
    memory.locator(".rk-scroll").evaluate((element) => {
      element.scrollTop = 0;
    });
  await memory.getByLabel("Provider").selectOption("supermemory");
  await scrollToTop();
  await expect(memory.getByLabel("Organization API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-supermemory-cloud");
  await memory.getByRole("button", { name: "Advanced", exact: true }).click();
  await memory.getByRole("button", { name: "Self-hosted", exact: true }).click();
  await expect(memory.getByLabel("Base URL", { exact: true })).toHaveValue("");
  await expect(memory.getByLabel("Instance API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-supermemory-local");

  await memory.getByLabel("Provider").selectOption("hindsight");
  await scrollToTop();
  await expect(memory.getByLabel("API key", { exact: true })).toBeVisible();
  await expect(memory.getByLabel("Recall from banks", { exact: true })).not.toBeVisible();
  await expect(memory.getByRole("button", { name: "Self-hosted", exact: true })).not.toBeVisible();
  await memory.getByLabel("API key", { exact: true }).fill("hindsight-test-key");
  await expect(memory.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "memory-hindsight-simple");
  await memory.getByRole("button", { name: "Advanced", exact: true }).click();
  const learn = memory.getByRole("switch", { name: "Learn from conversations" });
  await expect(learn).toBeChecked();
  await memory.getByLabel("Recall from banks", { exact: true }).fill("other-app");
  await learn.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureScreenshot(page, testInfo, "memory-hindsight-cloud");
  await memory.getByLabel("API key", { exact: true }).fill("");
  await memory.getByRole("button", { name: "Self-hosted", exact: true }).click();
  await memory.getByLabel("Base URL", { exact: true }).fill("http://hindsight.example.test:8888");
  const connect = memory.getByRole("button", { name: "Connect", exact: true });
  await expect(connect).toBeEnabled();
  await connect.evaluate((element) => element.scrollIntoView({ block: "center" }));
  await captureScreenshot(page, testInfo, "memory-hindsight-local");
  await expect(memory.getByRole("switch", { name: "Recall automatically" })).toBeChecked();
  await expect(memory.getByRole("button", { name: "Medium", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(memory.getByRole("button", { name: "Summaries", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const skipUnrelated = memory.getByRole("switch", { name: "Skip unrelated memories" });
  await expect(skipUnrelated).not.toBeChecked();
  // The section opens with an animation, so scroll again until it has reached its full height.
  await expect(async () => {
    await memory.locator(".rk-scroll").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(skipUnrelated).toBeInViewport({ timeout: 300 });
  }).toPass();
  await captureScreenshot(page, testInfo, "memory-hindsight-advanced");
  await skipUnrelated.click();
  await memory.getByRole("button", { name: "High", exact: true }).click();
  await expect(skipUnrelated).toBeChecked();
  await expect(memory.getByRole("button", { name: "High", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await memory.getByLabel("Provider").selectOption("honcho");
  await scrollToTop();
  await memory.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(memory.getByRole("button", { name: "Cloud", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(memory.getByLabel("API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-honcho-cloud-dark");
  await documents.scrollIntoViewIfNeeded();
  await expect(documents).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-dark-bottom");
});
