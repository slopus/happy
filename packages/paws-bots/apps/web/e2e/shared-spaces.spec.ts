import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

async function openBotInSpace(page: Page, spaceId: string, botId: string, name: string) {
  await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), spaceId);
  await page.goto(`/app/${botId}`);
  await expect(page.getByPlaceholder(`Message ${name}`)).toBeVisible();
}

async function send(page: Page, text: string) {
  const composer = page.getByRole("combobox", { name: /Message/ });
  await composer.fill(text);
  await composer.press("Enter");
  await expect(page.getByTestId("message-user-bubble").filter({ hasText: text })).toBeVisible();
}

test("an owner invites someone by link and both see the space's members", async ({
  browser,
}, testInfo) => {
  const owner = await browser.newContext();
  const invitee = await browser.newContext();
  const ownerPage = await owner.newPage();
  const inviteePage = await invitee.newPage();
  await owner.grantPermissions(["clipboard-read", "clipboard-write"]);
  const stamp = Date.now();

  await signup(ownerPage, `share-owner-${stamp}@rakazo.test`, "password12", "Ada Owner");
  await completeOnboarding(ownerPage);
  const home = await rpc<{ id: string }>(ownerPage, "spaces/create", { name: "Home" });
  await ownerPage.reload();

  const ownerSidebar = ownerPage.locator("aside").first();
  await ownerSidebar.getByRole("button", { name: "Actions for Home" }).click();
  await ownerPage.getByRole("menuitem", { name: "Settings" }).click();
  const ownerSettings = ownerPage.getByTestId("user-settings");
  await expect(ownerSettings).toHaveAttribute("data-settings-section", "space");
  await expect(ownerSettings.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(ownerSettings.getByText("Owner", { exact: true })).toBeVisible();
  await expect(ownerSettings.getByRole("button", { name: "Leave space" })).toHaveCount(0);

  await ownerSettings.getByRole("button", { name: "Invite" }).click();
  await expect(ownerPage.getByText("Invite link copied")).toBeVisible();
  const inviteUrl = await ownerPage.evaluate(() => navigator.clipboard.readText());
  expect(inviteUrl).toMatch(/\/invite\//);
  await captureScreenshot(ownerPage, testInfo, "space-members-owner");

  // A signed-out invitee signs in first and comes back to the invite.
  const invitePath = new URL(inviteUrl).pathname;
  await inviteePage.goto(invitePath);
  await expect(inviteePage).toHaveURL(/\/sign-in\?next=%2Finvite%2F/);

  await signup(inviteePage, `share-invitee-${stamp}@rakazo.test`, "password12", "Bob Invitee");
  await completeOnboarding(inviteePage);
  await inviteePage.goto(invitePath);
  await expect(inviteePage.getByRole("heading", { name: "Join Home" })).toBeVisible();
  await expect(inviteePage.getByText("Ada Owner invited you")).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-invite");
  await inviteePage.getByRole("button", { name: "Join", exact: true }).click();
  await inviteePage.waitForURL(/\/app/);

  const inviteeSidebar = inviteePage.locator("aside").first();
  await expect(inviteeSidebar.getByText("Home", { exact: true })).toBeVisible();
  await inviteeSidebar.getByRole("button", { name: "Actions for Home" }).click();
  await inviteePage.getByRole("menuitem", { name: "Settings" }).click();
  const inviteeSettings = inviteePage.getByTestId("user-settings");
  await expect(inviteeSettings.getByText("Ada Owner")).toBeVisible();
  await expect(inviteeSettings.getByText("Bob Invitee")).toBeVisible();
  await expect(inviteeSettings.getByRole("button", { name: "Invite" })).toHaveCount(0);
  await expect(inviteeSettings.getByRole("button", { name: "Leave space" })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-members-member");

  // Both people talk to one bot in the shared space; each sees who wrote what.
  const inHome = { "x-rakazo-space-id": home.id };
  const post = async <T>(path: string, json: unknown) =>
    ownerPage.request
      .post(`/rpc/${path}`, { headers: inHome, data: { json } })
      .then(async (response) => ((await response.json()) as { json: T }).json);
  const bot = await post<{ id: string }>("bots/create", {
    name: "Family",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  const planner = await post<{ id: string }>("bots/create", {
    name: "Planner",
    title: "",
    description: "",
    notifyOnFinish: true,
    computerMode: "team",
    color: "#2A92FE",
  });
  // Each person reads for themselves: what Ada writes is new to Bob, not to her. Bob is in
  // another chat first, so his shell does not open Family, and read it, when it appears.
  const familyRow = (page: Page) =>
    page.locator("aside").first().locator(`[data-roster-bot-id="${bot.id}"]`);
  await openBotInSpace(inviteePage, home.id, planner.id, "Planner");
  await openBotInSpace(ownerPage, home.id, bot.id, "Family");
  await send(ownerPage, "Can you plan dinner for Saturday?");
  await inviteePage.reload();
  await expect(familyRow(inviteePage)).toHaveAttribute("data-roster-unread", "true");
  await captureScreenshot(inviteePage, testInfo, "shared-unread-invitee");
  await ownerPage.bringToFront();
  await expect(familyRow(ownerPage)).not.toHaveAttribute("data-roster-unread", "true");

  await inviteePage.bringToFront();
  await openBotInSpace(inviteePage, home.id, bot.id, "Family");
  await expect(familyRow(inviteePage)).not.toHaveAttribute("data-roster-unread", "true");
  await send(inviteePage, "Make it vegetarian please");
  await expect(inviteePage.getByText("Ada Owner", { exact: true })).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "shared-thread-invitee");
  await ownerPage.reload();
  await expect(ownerPage.getByText("Bob Invitee", { exact: true })).toBeVisible();
  await captureScreenshot(ownerPage, testInfo, "shared-thread-owner");

  // A group in the shared space: each bot's reply is named and in its own color.
  const group = await post<{ id: string }>("groups/create", {
    name: "Household",
    botIds: [bot.id, planner.id],
  });
  await inviteePage.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await inviteePage.goto(`/app/g/${group.id}`);
  await send(inviteePage, "@everyone what should we cook tonight?");
  await expect(inviteePage.getByTestId("message-bot-bubble")).toHaveCount(2, { timeout: 30_000 });
  await expect(inviteePage.getByText("Planner", { exact: true }).last()).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "shared-group-invitee");

  // The link was single use. Leave the chat first: its open streams react to the session
  // change and navigate the page, which aborts the next sign-up navigation.
  await inviteePage.goto("about:blank");
  await invitee.clearCookies();
  await signup(inviteePage, `share-late-${stamp}@rakazo.test`, "password12", "Late Invitee");
  await completeOnboarding(inviteePage);
  await inviteePage.goto(invitePath);
  await expect(
    inviteePage.getByRole("heading", { name: "This invite link is no longer valid." }),
  ).toBeVisible();
  await captureScreenshot(inviteePage, testInfo, "space-invite-invalid");

  await owner.close();
  await invitee.close();
});
