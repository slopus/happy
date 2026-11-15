import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  captureScreenshot,
  completeOnboarding,
  createNamedBot,
  openNewGroup,
  rpc,
  signup,
} from "./helpers";

async function createBot(page: Page, name: string) {
  return createNamedBot(page, name);
}

test("create group from + and see two bots in one transcript", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `group-${stamp}@rakazo.test`, "password12", "Group E2E");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  const researcherId = await createBot(page, "Researcher");
  const writerId = await createBot(page, "Research Writer");

  await openNewGroup(page);
  await page.locator("label:has-text('Name') input").fill("Draft team");
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("checkbox", { name: "Add Researcher to the group" }).click();
  await panel.getByRole("checkbox", { name: "Add Research Writer to the group" }).click();
  await captureScreenshot(page, testInfo, "group-creation");
  await page.route("**/rpc/groups/create", async (route) => route.abort("failed"));
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await expect(panel.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(page.getByRole("button", { name: "Create group", exact: true })).toBeEnabled();
  await page.unroute("**/rpc/groups/create");
  await page.getByRole("button", { name: "Create group", exact: true }).click();
  await page.waitForURL(/\/app\/g\/[^/]+$/);
  const groupUrl = page.url();
  const draftGroupId = new URL(groupUrl).pathname.split("/").at(-1)!;
  const reviewGroup = await rpc<{ id: string }>(page, "groups/create", {
    name: "Review team",
    botIds: [researcherId, writerId],
  });
  await rpc(page, "voice/connect", {
    provider: "scripted",
    apiKey: "fake-group-voice-key",
  });
  await page.reload();
  await expect(page).toHaveURL(groupUrl);
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible();

  const groups = await rpc<
    Array<{
      id: string;
      members: Array<{ botId: string; name: string; color: string; status?: string }>;
    }>
  >(page, "groups/list", {});
  const groupSnapshot = await rpc<{
    members?: Array<{ botId: string; name: string; color: string; status?: string }>;
  }>(page, "threads/get", { groupId: draftGroupId });
  await page.route("**/rpc/groups/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: groups.map((group) => ({
          ...group,
          members: group.members.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        })),
      }),
    });
  });
  await page.route("**/rpc/threads/get", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          ...groupSnapshot,
          members: groupSnapshot.members?.map((member, index) => ({
            ...member,
            status: index === 0 ? "running" : "idle",
          })),
        },
      }),
    });
  });
  await page.reload();
  // Anchor ^ so Now/Recent activity rows ("Bot, Draft team, …") do not match.
  const groupAvatar = page
    .locator("aside")
    .first()
    .getByRole("button", { name: /^Draft team/ })
    .locator(".rakazo-group-avatar");
  await expect(groupAvatar).toBeVisible();
  await expect(groupAvatar.locator(".rakazo-organic-avatar")).toHaveCount(2);
  const workingAvatar = groupAvatar.locator('[data-working="true"]');
  await expect(workingAvatar).toHaveCount(1);
  await expect(workingAvatar.locator(".rakazo-organic-avatar-body-working")).toHaveCSS(
    "animation-name",
    /rakazo-organic-/,
  );
  await captureScreenshot(page, testInfo, "group-avatar-active");
  await page.unroute("**/rpc/groups/list");
  await page.unroute("**/rpc/threads/get");
  await page.reload();

  // The route header renders before bootstrap finishes restoring the group.
  // Wait for its composer before opening a panel that bootstrap may reset.
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible();
  const groupPill = page.getByTestId("bot-settings-trigger");
  if ((await groupPill.getAttribute("aria-expanded")) !== "true") await groupPill.click();
  const desktopSettings = page.getByTestId("side-panel");
  const groupName = desktopSettings.getByRole("textbox", { name: "Name", exact: true });
  await groupName.fill("Unsaved Draft team name");
  const sidebar = page.locator("aside").first();
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toBeVisible();
  await expect(desktopSettings).toHaveAttribute("data-panel", "closed");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(groupName).toHaveValue("Draft team");
  await page.route("**/rpc/groups/update", async (route) => route.abort("failed"));
  await desktopSettings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(desktopSettings.getByRole("alert")).toHaveText("Could not reach the server");
  await expect(desktopSettings.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await page.unroute("**/rpc/groups/update");
  await desktopSettings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(desktopSettings).not.toBeVisible();

  await page
    .getByRole("combobox", { name: "Message Draft team" })
    .fill("@Researcher unfinished draft");
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toHaveValue("");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toHaveValue(
    "@Researcher unfinished draft",
  );

  const composer = page.getByRole("combobox", { name: "Message Draft team" });
  await composer.fill("@Res");
  await captureScreenshot(page, testInfo, "group-mention-picker");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.pressSequentially("turn the sources into a draft. @Res");
  await page.getByRole("option", { name: "@Researcher", exact: true }).click();
  await expect(page.getByTestId("mention-chip").filter({ hasText: "Researcher" })).toBeVisible();
  await captureScreenshot(page, testInfo, "group-inline-mentions");
  await composer.fill(`${await composer.inputValue()}gather sources.`);
  await composer.press("Enter");

  await expect(page.getByTestId("transcript")).toContainText(/handled|on it|gather/i, {
    timeout: 60_000,
  });
  const transcript = page.getByTestId("transcript");
  await expect(transcript.getByText("Researcher", { exact: true }).first()).toBeVisible();
  await expect(transcript.getByText("Research Writer", { exact: true }).first()).toBeVisible();
  const researcherSpeak = transcript
    .locator("div")
    .filter({ has: page.getByText("Researcher", { exact: true }) })
    .filter({ has: page.getByRole("button", { name: "Speak this reply" }) })
    .first()
    .getByRole("button", { name: "Speak this reply" });
  const [speechRequest] = await Promise.all([
    page.waitForRequest(
      (request) => request.url().includes("/api/voice/speak") && request.method() === "POST",
    ),
    researcherSpeak.click(),
  ]);
  expect(speechRequest.postDataJSON()).toMatchObject({ botId: researcherId });
  await captureScreenshot(page, testInfo, "group-transcript");

  await composer.fill("@Res");
  await page.getByRole("option", { name: "@Research Writer", exact: true }).click();
  await expect(
    page.getByTestId("mention-chip").filter({ hasText: "Research Writer" }),
  ).toBeVisible();
  await composer.pressSequentially("ask me which city to use");
  await composer.press("Enter");
  // threads/get can observe waiting_input before the shell realtime feed paints the ask card.
  await expect
    .poll(
      async () => {
        const snapshot = await rpc<{ run?: { status: string } | null }>(page, "threads/get", {
          groupId: draftGroupId,
        });
        return snapshot.run?.status ?? null;
      },
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const cityAsk = page.locator("p").filter({ hasText: /^Which city should I use\?$/ });
  if ((await cityAsk.count()) === 0) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible({
      timeout: 15_000,
    });
  }
  await expect(cityAsk).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Edit first" })).toHaveCount(0);
  await composer.fill("Paris");
  await composer.press("Enter");
  const cityAnswer = page.getByTestId("message-user-bubble").filter({ hasText: /^Paris$/ });
  await expect(cityAnswer).toBeVisible({ timeout: 30_000 });
  const answeredQuestion = page
    .getByTestId("question-card")
    .filter({ hasText: "Which city should I use?" });
  await expect(answeredQuestion).toHaveClass(/opacity-50/);
  await expect(answeredQuestion).not.toContainText("Paris");
  await captureScreenshot(page, testInfo, "answered-question-composer-reply");

  const firstMessage = transcript.locator("[data-message-id]").first();
  await firstMessage.hover();
  const replyButton = firstMessage.getByRole("button", { name: "Reply" });
  await expect(replyButton).toBeVisible();
  await replyButton.click();
  const excerpt = await firstMessage.getByTestId("message-user-bubble").innerText();
  await expect(page.getByTestId("reply-chip")).toContainText(`You: ${excerpt.split(/\r?\n/u)[0]}`);
  await expect(
    page.getByTestId("reply-chip").getByRole("button", { name: "Cancel reply" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel reply" }).click();

  let releaseReviewSnapshot!: () => void;
  let sawReviewSnapshot!: () => void;
  const reviewSnapshotReleased = new Promise<void>((resolve) => {
    releaseReviewSnapshot = resolve;
  });
  const reviewSnapshotIntercepted = new Promise<void>((resolve) => {
    sawReviewSnapshot = resolve;
  });
  await page.route("**/rpc/threads/get", async (route) => {
    if (route.request().postData()?.includes(reviewGroup.id) !== true) {
      await route.continue();
      return;
    }
    sawReviewSnapshot();
    await reviewSnapshotReleased;
    await route.continue();
  });
  await sidebar.getByRole("button", { name: /^Review team/ }).click();
  await reviewSnapshotIntercepted;
  await expect(page).toHaveURL(new RegExp(`/app/g/${reviewGroup.id}$`));
  await expect(page.getByTestId("transcript").getByTestId("ask-answer")).toHaveCount(0);
  releaseReviewSnapshot();
  await expect(page.getByRole("combobox", { name: "Message Review team" })).toBeVisible();
  await page.unroute("**/rpc/threads/get");
  await sidebar.getByRole("button", { name: /^Draft team/ }).click();
  await expect(cityAnswer).toBeVisible();

  await composer.fill(
    "@Researcher write path notes/group-preview.md and attach it to the thread says # Group artifact",
  );
  await composer.press("Enter");
  const groupMarkdown = page.getByRole("button", { name: "Preview group-preview.md" });
  await expect(groupMarkdown).toBeVisible({ timeout: 30_000 });
  await groupMarkdown.click();
  const markdownDialog = page.getByRole("dialog", { name: "group-preview.md" });
  await expect(markdownDialog.getByRole("heading", { name: "Group artifact" })).toBeVisible();
  await markdownDialog.getByRole("button", { name: "Close preview" }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await expect(page.getByTestId("app-rail")).toHaveCount(0);
  const transcriptBox = await transcript.boundingBox();
  expect(transcriptBox?.x).toBeLessThanOrEqual(16);
  expect(transcriptBox?.width).toBeGreaterThan(390 - 24);
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("side-panel");
  await expect(settings).toHaveAttribute("data-panel", "group-settings");
  expect((await settings.boundingBox())?.width).toBeLessThanOrEqual(390);
  await captureScreenshot(page, testInfo, "group-settings-mobile");
  await settings.getByRole("button", { name: "Delete group", exact: true }).click();
  const confirmDelete = page.getByRole("alertdialog", { name: "Delete Draft team?" });
  await expect(confirmDelete).toBeVisible();
  await captureScreenshot(page, testInfo, "group-settings-delete-confirm-mobile");
  await page.keyboard.press("Escape");
  await expect(confirmDelete).toHaveCount(0);
  await expect(settings).toHaveAttribute("data-panel", "group-settings");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveAttribute("data-panel", "closed");
  await page.getByTestId("bot-settings-trigger").click();
  await settings.getByRole("button", { name: "Close panel", exact: true }).click();
  await expect(settings).toHaveAttribute("data-panel", "closed");
  await expect(page.getByRole("combobox", { name: "Message Draft team" })).toBeVisible();

  await rpc(page, "groups/remove", { groupId: reviewGroup.id });
  await page.goto(`/app/g/${reviewGroup.id}`);
  await page.waitForURL(/\/app\/(?!g\/)[^/]+$/);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible();
});
