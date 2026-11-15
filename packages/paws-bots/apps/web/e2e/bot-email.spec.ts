import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotPanelTab,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("a bot gets its email address from its settings and lists it in the Vault", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-email-${stamp}@rakazo.test`, "password12", "Bot Email");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await openBotPanelTab(page, "Computer");
  const header = page.getByTestId("bot-profile-header");

  await header.getByRole("button", { name: "Get an email address" }).click();
  await header.getByRole("textbox", { name: "Email address" }).fill(`scout-${stamp}`);
  await header.getByRole("button", { name: "Claim" }).click();
  const address = `scout-${stamp}@bots.rakazo.test`;
  await expect(header.getByText(address)).toBeVisible();
  await expect(header.getByRole("button", { name: `Copy ${address}` })).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-email-address");
  expect(await rpc(page, "bots/emailAddress", { botId })).toEqual({
    domain: "bots.rakazo.test",
    address,
  });

  const settings = await openUserSettings(page, "vault");
  const listed = settings.getByTestId("vault-bot-emails");
  await expect(listed).toContainText(address);
  await captureScreenshot(page, testInfo, "vault-bot-email");
});

test("a bot email claim stays in its shell's Space when another tab switches Spaces", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `bot-email-space-${stamp}@rakazo.test`, "password12", "Bot Email Space");
  await completeOnboarding(page);

  const home = await rpc<{ id: string }>(page, "spaces/create", { name: "Email Home" });
  const other = await rpc<{ id: string }>(page, "spaces/create", { name: "Email Other" });
  const createBot = async (spaceId: string, name: string) => {
    const response = await page.request.post("/rpc/bots/create", {
      headers: { "x-rakazo-space-id": spaceId },
      data: {
        json: { name, description: "", notifyOnFinish: true, computerMode: "team" },
      },
    });
    expect(response.ok()).toBe(true);
    return ((await response.json()) as { json: { id: string } }).json;
  };
  const scout = await createBot(home.id, "Scout");
  const otherBot = await createBot(other.id, "Other");

  await page.evaluate((id) => localStorage.setItem("rakazo:space-id", id), home.id);
  await page.goto(`/app/${scout.id}`);
  await expect(page.getByPlaceholder("Message Scout")).toBeVisible();
  await openBotPanelTab(page, "Computer");
  const header = page.getByTestId("bot-profile-header");
  await expect(header.getByRole("button", { name: "Get an email address" })).toBeVisible();

  const otherTab = await page.context().newPage();
  await otherTab.addInitScript((id) => localStorage.setItem("rakazo:space-id", id), other.id);
  await otherTab.goto(`/app/${otherBot.id}`);
  await expect(otherTab.getByPlaceholder("Message Other")).toBeVisible();

  await header.getByRole("button", { name: "Get an email address" }).click();
  await header.getByRole("textbox", { name: "Email address" }).fill(`scout-${stamp}`);
  await header.getByRole("button", { name: "Claim" }).click();
  const address = `scout-${stamp}@bots.rakazo.test`;
  await expect(header.getByText(address)).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-email-space-claim");
  const response = await page.request.post("/rpc/bots/emailAddress", {
    headers: { "x-rakazo-space-id": home.id },
    data: { json: { botId: scout.id } },
  });
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ json: { address } });

  await otherTab.close();
});
