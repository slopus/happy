import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

test("shows the spending limit once a card is saved, sets a monthly limit, and lists a payment", async ({
  page,
}, testInfo) => {
  await signup(page, `spending-limit-${Date.now()}@rakazo.test`, "password12", "Spender");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  await expect(settings.getByTestId("approval-mode")).toBeVisible();
  // Nothing can pay yet, so there is nothing to limit.
  await expect(settings.getByTestId("spending-limit")).toHaveCount(0);

  await settings.getByTestId("settings-nav-vault").click();
  await settings.getByTestId("vault").getByTestId("vault-new").click();
  await page.getByTestId("vault-new-card").click();
  const editor = page.getByTestId("vault-editor");
  await editor.getByLabel("Card number", { exact: true }).fill("4242424242424242");
  await editor.getByLabel("Expiry", { exact: true }).fill("0830");
  await editor.getByLabel("Security code", { exact: true }).fill("123");
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);

  await settings.getByTestId("settings-nav-confirmations").click();
  const limit = settings.getByTestId("spending-limit");
  await expect(limit).toContainText("None");
  await limit.getByRole("button", { name: "Set", exact: true }).click();
  await limit.getByRole("textbox", { name: "Amount" }).fill("200");
  await captureScreenshot(page, testInfo, "spending-limit-edit");
  await limit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(limit).toContainText("$200.00 a month");
  await expect(limit).toContainText("$0.00 spent this month");
  await captureScreenshot(page, testInfo, "spending-limit-set");

  // The offline wallet signs in on its first check, then the bot buys through it.
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await rpc(page, "paymentWallet/connect", {});
  await expect
    .poll(async () => (await rpc<{ status: string }>(page, "paymentWallet/status", {})).status)
    .toBe("connected");
  await page.getByPlaceholder(/Message/).fill("buy from the fixture shop");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("transcript").getByText(/Purchase \S+ is approved/)).toBeVisible({
    timeout: 60_000,
  });

  const reopened = await openUserSettings(page);
  await reopened.getByTestId("settings-nav-confirmations").click();
  const payments = reopened.getByTestId("spending-payments");
  await expect(payments.getByRole("listitem")).toHaveCount(1);
  await expect(payments).toContainText("shop.example.test");
  await expect(payments).toContainText("$23.40");
  await expect(reopened.getByTestId("spending-limit")).toContainText("$23.40 spent this month");
  await captureScreenshot(page, testInfo, "spending-limit-payments");
});

test("shows zero- and three-decimal currencies in payment history", async ({ page }, testInfo) => {
  await signup(page, `spending-currencies-${Date.now()}@rakazo.test`, "password12", "Spender");
  await completeOnboarding(page);
  await page.route("**/rpc/spendingLimit/get", (route) =>
    route.fulfill({ json: { json: { shown: true, limit: null, spent: 0 } } }),
  );
  await page.route("**/rpc/spendingLimit/payments", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "jpy",
            site: "yen.example.test",
            amount: 1000,
            currency: "jpy",
            botName: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: "kwd",
            site: "dinar.example.test",
            amount: 1234,
            currency: "kwd",
            botName: null,
            createdAt: new Date().toISOString(),
          },
          {
            id: "usd",
            site: "dollar.example.test",
            amount: 2340,
            currency: "usd",
            botName: null,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-confirmations").click();
  const payments = settings.getByTestId("spending-payments");
  await expect(
    payments.getByRole("listitem").filter({ hasText: "yen.example.test" }),
  ).toContainText("¥1,000");
  await expect(
    payments.getByRole("listitem").filter({ hasText: "dinar.example.test" }),
  ).toContainText("KWD");
  await expect(
    payments.getByRole("listitem").filter({ hasText: "dinar.example.test" }),
  ).toContainText("1.234");
  await expect(
    payments.getByRole("listitem").filter({ hasText: "dollar.example.test" }),
  ).toContainText("$23.40");
  await captureScreenshot(page, testInfo, "spending-payment-currencies");
});
