import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { socialPresentation } from "../../../packages/auth/src/social-presentation";
import { LAST_SIGN_IN_COOKIE } from "../../../packages/contracts/src/auth";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const passwordOnly = {
  passwordAuth: true,
  sso: null,
  passwordReset: true,
  resetUrl: "http://127.0.0.1:5173/reset-password",
  providers: [] as { id: string; name: string }[],
};

const both = [
  { id: "google", name: "Google", presentation: socialPresentation("google") },
  { id: "apple", name: "Apple", presentation: socialPresentation("apple") },
];

async function mockSignedOut(page: Page, providers: typeof both | []) {
  await page.route("**/api/auth/get-session**", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/sign-in/social", (route) =>
    route.fulfill({ status: 404, json: { message: "not called" } }),
  );
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { ...passwordOnly, providers } }),
  );
}

test("sign-in offers Google and Apple before email", async ({ page }, testInfo) => {
  await mockSignedOut(page, both);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  const google = page.getByRole("button", { name: "Continue with Google" });
  const apple = page.getByRole("button", { name: "Continue with Apple" });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(apple).toBeVisible();
  await expect(emailChoice).toBeVisible();

  await expect(page.getByRole("link", { name: "Sign up" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const appleBox = await apple.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  expect(googleBox && appleBox && appleBox.y >= googleBox.y + googleBox.height).toBeTruthy();
  expect(googleBox && appleBox && Math.abs(googleBox.width - appleBox.width) < 2).toBeTruthy();
  expect(googleBox && googleBox.height >= 44 && googleBox.height <= 52).toBeTruthy();
  expect(emailBox && googleBox && emailBox.y > googleBox.y).toBeTruthy();
  expect(emailBox && googleBox && Math.abs(emailBox.width - googleBox.width) < 2).toBeTruthy();
  expect(emailBox && googleBox && Math.abs(emailBox.height - googleBox.height) < 2).toBeTruthy();

  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "sign-in-chooser");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sign-in-chooser-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await emailChoice.click();
  await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
  const back = page.getByRole("button", { name: "Back", exact: true });
  await expect(back).toBeVisible();
  await expect(back.locator("svg")).toBeVisible();
  await expect(google).toHaveCount(0);
  const backBox = await back.boundingBox();
  const emailField = await page.getByLabel("Email", { exact: true }).boundingBox();
  expect(backBox && emailField && Math.abs(backBox.x - emailField.x) < 24).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-email");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await captureScreenshot(page, testInfo, "sign-in-email-dark");
  await page.emulateMedia({ colorScheme: "light" });

  await page.goto("/sign-up");
  await expect(page.getByRole("heading", { name: "Create your Rakazo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-up-chooser");
});

test("returning people see the sign-in method they used last", async ({ page }, testInfo) => {
  await mockSignedOut(page, both);
  await page
    .context()
    .addCookies([
      { name: LAST_SIGN_IN_COOKIE, value: "google", url: testInfo.project.use.baseURL! },
    ]);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Continue with Google" });
  await expect(google.getByText("Last used")).toBeVisible();
  await expect(page.getByText("Last used")).toHaveCount(1);
  await captureScreenshot(page, testInfo, "sign-in-last-used");

  await page.emulateMedia({ colorScheme: "dark" });
  await captureScreenshot(page, testInfo, "sign-in-last-used-dark");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "light" });
  await expect(google.getByText("Last used")).toBeVisible();
  await captureScreenshot(page, testInfo, "sign-in-last-used-mobile");
});

test("a successful email sign-up is remembered for the next sign-in", async ({ page }) => {
  await signup(page, `last-used-${Date.now()}@rakazo.test`, "password12", "Last Used QA");
  const cookie = (await page.context().cookies()).find(({ name }) => name === LAST_SIGN_IN_COOKIE);
  expect(cookie?.value).toBe("email");
  expect(cookie?.httpOnly).toBe(false);
  await mockSignedOut(page, both);
  await page.goto("/sign-in");
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(emailChoice.getByText("Last used")).toBeVisible();
});

test("one provider spans the chooser row", async ({ page }, testInfo) => {
  await mockSignedOut(page, [
    { id: "google", name: "Google", presentation: socialPresentation("google") },
  ]);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Continue with Google" });
  const emailChoice = page.getByRole("button", { name: "Continue with email" });
  await expect(google).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with Apple" })).toHaveCount(0);
  const googleBox = await google.boundingBox();
  const emailBox = await emailChoice.boundingBox();
  const card = page.locator("form");
  const cardBox = await card.boundingBox();
  expect(googleBox && cardBox && googleBox.width > cardBox.width * 0.7).toBeTruthy();
  expect(emailBox && googleBox && Math.abs(emailBox.width - googleBox.width) < 2).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-one-provider");
});

test("sign-in hides the chooser when none are configured", async ({ page }, testInfo) => {
  await mockSignedOut(page, []);
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Rakazo" })).toBeVisible();
  await expect(page.getByText("Welcome back")).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Back", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-no-social");
});

test("chooser stacks the providers on a phone", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockSignedOut(page, both);
  await page.goto("/sign-in");
  const google = page.getByRole("button", { name: "Continue with Google" });
  const apple = page.getByRole("button", { name: "Continue with Apple" });
  await expect(google).toBeVisible();
  const googleBox = await google.boundingBox();
  const appleBox = await apple.boundingBox();
  expect(googleBox && appleBox && appleBox.y > googleBox.y + 20).toBeTruthy();
  expect(googleBox && appleBox && Math.abs(googleBox.width - appleBox.width) < 2).toBeTruthy();
  await captureScreenshot(page, testInfo, "sign-in-chooser-mobile");
});

test("provider-only sign-in keeps both provider actions as buttons", async ({ page }, testInfo) => {
  await mockSignedOut(page, both);
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { ...passwordOnly, passwordAuth: false, providers: both } }),
  );
  await page.goto("/sign-in");
  for (const name of ["Continue with Google", "Continue with Apple"]) {
    const button = page.getByRole("button", { name });
    await expect(button).toBeVisible();
    expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "sign-in-provider-only");
});

test("linked social accounts use a supported deletion confirmation method", async ({
  page,
}, testInfo) => {
  await signup(
    page,
    `social-confirmation-${Date.now()}@rakazo.test`,
    "password12",
    "Confirmation QA",
  );
  await completeOnboarding(page);
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { ...passwordOnly, providers: both } }),
  );
  await page.route("**/api/auth/account-security", (route) =>
    route.fulfill({
      json: {
        hasPassword: false,
        freshOidcAuth: false,
        ssoLinked: false,
        sso: null,
        emailDeletion: true,
        linkedProviderIds: ["google", "apple"],
        // An older in-flight server must not restore unsupported confirmation choices.
        reauthenticationProviders: both,
      },
    }),
  );
  const settings = await openUserSettings(page);
  await settings.getByTestId("delete-account").click();
  await expect(
    settings.getByRole("button", { name: "Send deletion code", exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("button", { name: "Sign in again", exact: true })).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Continue with Google", exact: true }),
  ).toHaveCount(0);
  await expect(
    settings.getByRole("button", { name: "Continue with Apple", exact: true }),
  ).toHaveCount(0);
  await captureScreenshot(page, testInfo, "social-account-deletion-confirmation");
});

test("provider errors stay centered below a contained stack", async ({ page }, testInfo) => {
  await mockSignedOut(page, both);
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        ...passwordOnly,
        providers: [{ id: "oidc", name: "Company" }, ...both],
      },
    }),
  );
  await page.goto("/sign-in?error=account_not_linked");
  const form = page.locator("form");
  const choices = form.getByRole("button", { name: /^Continue with (Google|Apple|email)$/ });
  await expect(choices).toHaveCount(3);
  const formBox = (await form.boundingBox())!;
  let previousBottom = 0;
  for (const choice of await choices.all()) {
    const box = (await choice.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(formBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(formBox.x + formBox.width);
    expect(box.y).toBeGreaterThanOrEqual(previousBottom);
    previousBottom = box.y + box.height;
  }
  const sso = form.getByRole("button", { name: "Continue with Company", exact: true });
  await expect(sso).toBeVisible();
  const ssoBox = (await sso.boundingBox())!;
  expect(ssoBox.y).toBeGreaterThanOrEqual(previousBottom);
  expect(ssoBox.width).toBeLessThan(formBox.width * 0.7);
  const error = page.getByRole("alert");
  await expect(error).toBeVisible();
  const errorBox = (await error.boundingBox())!;
  expect(errorBox.y).toBeGreaterThanOrEqual(ssoBox.y + ssoBox.height);
  expect(Math.abs(errorBox.x + errorBox.width / 2 - formBox.x - formBox.width / 2)).toBeLessThan(2);
  await expect(error).toHaveCSS("text-align", "center");
  await page.emulateMedia({ colorScheme: "dark" });
  await captureScreenshot(page, testInfo, "sign-in-provider-error");
});

test("long organization names stay inside the sign-in card", async ({ page }) => {
  await mockSignedOut(page, both);
  const name = "Example organization with a deliberately long sign-in connection name".repeat(3);
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({
      json: {
        ...passwordOnly,
        providers: [{ id: "oidc", name }, ...both],
      },
    }),
  );
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/sign-in");
    const company = page.getByRole("button", { name: `Continue with ${name}`, exact: true });
    await expect(company).toBeVisible();
    const box = (await company.boundingBox())!;
    const formBox = (await page.locator("form").boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(formBox.x);
    expect(box.x + box.width).toBeLessThanOrEqual(formBox.x + formBox.width);
    await expect(company.locator("span")).toHaveCSS("text-overflow", "ellipsis");
  }
});
