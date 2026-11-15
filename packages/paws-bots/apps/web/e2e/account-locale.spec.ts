import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

for (const language of [
  {
    locale: "zh-CN",
    name: "简体中文",
    general: "通用",
    account: "账户",
    label: "语言",
    data: "你的数据",
    import: "导入",
  },
  {
    locale: "zh-TW",
    name: "繁體中文",
    general: "一般",
    account: "帳號",
    label: "語言",
    data: "你的資料",
    import: "匯入",
  },
]) {
  test(`${language.locale} settings and data controls stay translated after reload`, async ({
    page,
  }, testInfo) => {
    await signup(
      page,
      `ui-locale-${language.locale}-${Date.now()}@rakazo.test`,
      "password12",
      "Locale QA",
    );
    await completeOnboarding(page, testInfo);
    const settings = await openUserSettings(page);
    const picker = settings.getByTestId("ui-locale-select");
    await picker.click();
    await page.getByRole("option", { name: language.name, exact: true }).click();
    await expect(
      settings.getByRole("heading", { name: language.general, exact: true }),
    ).toBeVisible();
    await expect(
      settings.getByRole("heading", { name: language.account, exact: true }),
    ).toBeVisible();
    await expect(settings.getByText(language.label, { exact: true })).toBeVisible();
    await expect(settings.getByRole("heading", { name: "聊天", exact: true })).toBeVisible();
    await expect(picker).toHaveText(language.name);
    await expect(page.locator("html")).toHaveAttribute("lang", language.locale);
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
    await captureScreenshot(page, testInfo, `ui-locale-settings-${language.locale}`);

    const data = settings.getByTestId("account-data");
    await data.scrollIntoViewIfNeeded();
    await expect(data.getByText(language.data, { exact: true })).toBeVisible();
    await expect(data.getByTestId("account-import")).toHaveText(language.import);
    await captureScreenshot(page, testInfo, `ui-locale-data-${language.locale}`);

    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", language.locale);
    await expect(page.getByTestId("ui-locale-select")).toHaveText(language.name);
    await expect(
      page.getByTestId("account-data").getByText(language.data, { exact: true }),
    ).toBeVisible();
    await page.getByTestId("ui-locale-select").click();
    await page.getByRole("option", { name: "English", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  });
}
